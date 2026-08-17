using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

var builder = WebApplication.CreateBuilder(args);

var dataDir = Environment.GetEnvironmentVariable("DATA_DIR") ?? "/data";
Directory.CreateDirectory(dataDir);
var dbPath = Path.Combine(dataDir, "ratings.db");
var serviceToken = Environment.GetEnvironmentVariable("SERVICE_TOKEN") ?? "";
if (string.IsNullOrWhiteSpace(serviceToken))
    throw new InvalidOperationException("SERVICE_TOKEN must be configured.");

builder.Services.AddSingleton(new AppConfig(
    DbPath: dbPath,
    TmdbToken: Environment.GetEnvironmentVariable("TMDB_TOKEN") ?? "",
    ServiceToken: serviceToken,
    ImdbRatingsUrl: Environment.GetEnvironmentVariable("IMDB_RATINGS_URL") ?? "https://datasets.imdbws.com/title.ratings.tsv.gz",
    RefreshUtcHour: int.TryParse(Environment.GetEnvironmentVariable("REFRESH_UTC_HOUR"), out var hour) ? Math.Clamp(hour, 0, 23) : 16,
    MinimumRatingRows: int.TryParse(Environment.GetEnvironmentVariable("MINIMUM_RATING_ROWS"), out var minRows) ? Math.Max(minRows, 1) : 100_000,
    TmdbMissCacheHours: int.TryParse(Environment.GetEnvironmentVariable("TMDB_MISS_CACHE_HOURS"), out var missHours) ? Math.Max(missHours, 1) : 1
));

builder.Services.AddHttpClient("imdb", client =>
{
    client.Timeout = TimeSpan.FromMinutes(10);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("LampaImdbRatings/1.0");
});

builder.Services.AddHttpClient("tmdb", (sp, client) =>
{
    var cfg = sp.GetRequiredService<AppConfig>();
    client.BaseAddress = new Uri("https://api.themoviedb.org/3/");
    client.Timeout = TimeSpan.FromSeconds(15);
    if (!string.IsNullOrWhiteSpace(cfg.TmdbToken))
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", cfg.TmdbToken);
});

builder.Services.AddSingleton<Db>();
builder.Services.AddSingleton<TmdbResolver>();
builder.Services.AddSingleton<RatingsUpdater>();
builder.Services.AddHostedService<RatingsRefreshWorker>();

builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

var database = app.Services.GetRequiredService<Db>();
await database.InitializeAsync();

app.MapGet("/health", async (Db db, AppConfig cfg) =>
{
    var meta = await db.GetMetadataAsync();
    var ready = meta.RatingCount > 0;
    var body = new
    {
        status = ready ? "ok" : "starting",
        ratings = meta.RatingCount,
        refreshedAt = meta.RefreshedAt,
        datasetLastModified = meta.LastModified,
        tmdbConfigured = !string.IsNullOrWhiteSpace(cfg.TmdbToken),
        tmdbMissCacheHours = cfg.TmdbMissCacheHours
    };
    return ready ? Results.Ok(body) : Results.Json(body, statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/health/live", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/ratings", async (HttpRequest http, BatchRequest request, Db db, TmdbResolver tmdb, AppConfig cfg, ILoggerFactory loggerFactory, CancellationToken ct) =>
{
    if (!Authorize(http, cfg.ServiceToken))
        return Results.Unauthorized();

    if (request.Items is not { Count: > 0 })
        return Results.BadRequest(new { error = "items is required" });

    var items = request.Items
        .Where(x => x.Tmdb > 0 || !string.IsNullOrWhiteSpace(x.Imdb))
        .Take(100)
        .DistinctBy(x => x.Key)
        .ToList();

    var imdbByKey = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
    var misses = new List<BatchItem>();

    foreach (var item in items)
    {
        if (IsImdbId(item.Imdb))
        {
            imdbByKey[item.Key] = item.Imdb;
            if (item.Tmdb > 0) await db.UpsertMappingAsync(item.NormalizedType, item.Tmdb, item.Imdb!, ct);
            continue;
        }

        var mapped = item.Tmdb > 0 ? await db.GetMappingAsync(item.NormalizedType, item.Tmdb, ct) : null;
        if (mapped is not null)
            imdbByKey[item.Key] = mapped;
        else
            misses.Add(item);
    }

    if (misses.Count > 0 && !string.IsNullOrWhiteSpace(cfg.TmdbToken))
    {
        var log = loggerFactory.CreateLogger("RatingsApi");
        await Parallel.ForEachAsync(
            misses,
            new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct },
            async (item, itemCt) =>
            {
                try
                {
                    var resolution = await tmdb.ResolveAsync(item.NormalizedType, item.Tmdb, itemCt);
                    if (resolution.Cacheable)
                        await db.UpsertMappingAsync(item.NormalizedType, item.Tmdb, resolution.ImdbId ?? "", itemCt);
                    lock (imdbByKey) imdbByKey[item.Key] = resolution.ImdbId;
                }
                catch (Exception ex) when (!itemCt.IsCancellationRequested)
                {
                    log.LogWarning(ex, "TMDB resolution failed for {MediaType}:{TmdbId}", item.NormalizedType, item.Tmdb);
                    lock (imdbByKey) imdbByKey[item.Key] = null;
                }
            });
    }

    var imdbIds = imdbByKey.Values.Where(IsImdbId).Cast<string>().Distinct().ToArray();
    var ratings = await db.GetRatingsAsync(imdbIds, ct);

    var response = new Dictionary<string, object?>();
    foreach (var item in items)
    {
        imdbByKey.TryGetValue(item.Key, out var imdb);
        if (imdb is not null && ratings.TryGetValue(imdb, out var r))
        {
            response[item.Key] = new { imdb, rating = r.Rating, votes = r.Votes };
        }
        else
        {
            response[item.Key] = new { imdb, rating = (double?)null, votes = (long?)null };
        }
    }

    return Results.Ok(new { items = response });
});

app.Run();

static bool Authorize(HttpRequest request, string expected)
{
    if (!request.Headers.TryGetValue("X-Api-Key", out var value)) return false;
    var actual = Encoding.UTF8.GetBytes(value.ToString());
    var expectedBytes = Encoding.UTF8.GetBytes(expected);
    return actual.Length == expectedBytes.Length && CryptographicOperations.FixedTimeEquals(actual, expectedBytes);
}

static bool IsImdbId(string? value) => value is not null && value.StartsWith("tt", StringComparison.Ordinal) && value.Length > 2 && value[2..].All(char.IsDigit);

record AppConfig(string DbPath, string TmdbToken, string ServiceToken, string ImdbRatingsUrl, int RefreshUtcHour, int MinimumRatingRows, int TmdbMissCacheHours);
record BatchRequest(List<BatchItem>? Items);
record BatchItem(string Type, long Tmdb, string? Imdb)
{
    public string NormalizedType => string.Equals(Type, "tv", StringComparison.OrdinalIgnoreCase) ? "tv" : "movie";
    public string Key => Tmdb > 0 ? $"{NormalizedType}:{Tmdb}" : $"imdb:{Imdb}";
}
record RatingRow(double Rating, long Votes);
record Metadata(long RatingCount, string? RefreshedAt, string? LastModified);
record TmdbResolution(string? ImdbId, bool Cacheable);

sealed class Db(AppConfig cfg)
{
    private string Cs => new SqliteConnectionStringBuilder { DataSource = cfg.DbPath, Mode = SqliteOpenMode.ReadWriteCreate, Cache = SqliteCacheMode.Shared, DefaultTimeout = 30 }.ToString();

    public async Task InitializeAsync()
    {
        await using var cn = new SqliteConnection(Cs);
        await cn.OpenAsync();
        await ExecAsync(cn, "PRAGMA journal_mode=WAL;");
        await ExecAsync(cn, "PRAGMA synchronous=NORMAL;");
        await ExecAsync(cn, """
            CREATE TABLE IF NOT EXISTS ratings(
              imdb_id TEXT PRIMARY KEY,
              rating REAL NOT NULL,
              votes INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tmdb_map(
              media_type TEXT NOT NULL,
              tmdb_id INTEGER NOT NULL,
              imdb_id TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(media_type, tmdb_id)
            );
            CREATE TABLE IF NOT EXISTS metadata(
              key TEXT PRIMARY KEY,
              value TEXT
            );
            """);
    }

    public async Task<string?> GetMappingAsync(string type, long tmdbId, CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        cmd.CommandText = "SELECT imdb_id,updated_at FROM tmdb_map WHERE media_type=$t AND tmdb_id=$id";
        cmd.Parameters.AddWithValue("$t", type); cmd.Parameters.AddWithValue("$id", tmdbId);
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        if (!await rd.ReadAsync(ct)) return null;

        var imdbId = rd.GetString(0);
        if (!string.IsNullOrEmpty(imdbId)) return imdbId;

        var freshUntil = DateTimeOffset.UtcNow.AddHours(-cfg.TmdbMissCacheHours);
        return DateTimeOffset.TryParse(rd.GetString(1), out var updatedAt) && updatedAt >= freshUntil ? "" : null;
    }

    public async Task UpsertMappingAsync(string type, long tmdbId, string imdbId, CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        cmd.CommandText = """
          INSERT INTO tmdb_map(media_type,tmdb_id,imdb_id,updated_at)
          VALUES($t,$id,$imdb,$now)
          ON CONFLICT(media_type,tmdb_id) DO UPDATE SET imdb_id=excluded.imdb_id, updated_at=excluded.updated_at
          """;
        cmd.Parameters.AddWithValue("$t", type); cmd.Parameters.AddWithValue("$id", tmdbId);
        cmd.Parameters.AddWithValue("$imdb", imdbId); cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<int> DeleteExpiredNegativeMappingsAsync(CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        cmd.CommandText = "DELETE FROM tmdb_map WHERE imdb_id='' AND updated_at < $cutoff";
        cmd.Parameters.AddWithValue("$cutoff", DateTimeOffset.UtcNow.AddHours(-cfg.TmdbMissCacheHours).ToString("O"));
        return await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<Dictionary<string, RatingRow>> GetRatingsAsync(IEnumerable<string> ids, CancellationToken ct)
    {
        var arr = ids.Distinct().ToArray();
        var result = new Dictionary<string, RatingRow>(StringComparer.Ordinal);
        if (arr.Length == 0) return result;

        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        var names = new List<string>();
        for (var i = 0; i < arr.Length; i++)
        {
            var n = "$p" + i; names.Add(n); cmd.Parameters.AddWithValue(n, arr[i]);
        }
        cmd.CommandText = $"SELECT imdb_id,rating,votes FROM ratings WHERE imdb_id IN ({string.Join(',', names)})";
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        while (await rd.ReadAsync(ct)) result[rd.GetString(0)] = new RatingRow(rd.GetDouble(1), rd.GetInt64(2));
        return result;
    }

    public async Task<(string? ETag, DateTimeOffset? LastModified, DateTimeOffset? RefreshedAt)> GetRefreshStateAsync(CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        var dict = new Dictionary<string, string?>();
        await using var cmd = cn.CreateCommand(); cmd.CommandText = "SELECT key,value FROM metadata WHERE key IN ('ratings_etag','ratings_last_modified','ratings_refreshed_at')";
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        while (await rd.ReadAsync(ct)) dict[rd.GetString(0)] = rd.IsDBNull(1) ? null : rd.GetString(1);
        DateTimeOffset? Parse(string k) => dict.TryGetValue(k, out var s) && DateTimeOffset.TryParse(s, out var d) ? d : null;
        return (dict.GetValueOrDefault("ratings_etag"), Parse("ratings_last_modified"), Parse("ratings_refreshed_at"));
    }

    public async Task BuildAndSwapRatingsAsync(Stream gzStream, string? etag, DateTimeOffset? lastModified, CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        long currentRows;
        await using (var countCmd = cn.CreateCommand())
        {
            countCmd.CommandText = "SELECT COUNT(*) FROM ratings";
            currentRows = (long)(await countCmd.ExecuteScalarAsync(ct) ?? 0L);
        }
        await ExecAsync(cn, "DROP TABLE IF EXISTS ratings_next; CREATE TABLE ratings_next(imdb_id TEXT PRIMARY KEY, rating REAL NOT NULL, votes INTEGER NOT NULL);");

        using var gzip = new GZipStream(gzStream, CompressionMode.Decompress, leaveOpen: true);
        using var reader = new StreamReader(gzip);
        var header = await reader.ReadLineAsync(ct);
        if (header != "tconst\taverageRating\tnumVotes")
            throw new InvalidDataException("IMDb ratings dataset has an unexpected header.");

        var inserted = 0;
        SqliteTransaction tx = (SqliteTransaction)await cn.BeginTransactionAsync(ct);
        var cmd = cn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO ratings_next(imdb_id,rating,votes) VALUES($i,$r,$v)";
        var pId = cmd.Parameters.Add("$i", SqliteType.Text);
        var pRating = cmd.Parameters.Add("$r", SqliteType.Real);
        var pVotes = cmd.Parameters.Add("$v", SqliteType.Integer);

        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            var parts = line.Split('\t');
            if (parts.Length != 3 || !double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var rating) || !long.TryParse(parts[2], out var votes)) continue;
            pId.Value = parts[0]; pRating.Value = rating; pVotes.Value = votes;
            await cmd.ExecuteNonQueryAsync(ct);
            inserted++;

            if (inserted % 50000 == 0)
            {
                await tx.CommitAsync(ct);
                await tx.DisposeAsync();
                tx = (SqliteTransaction)await cn.BeginTransactionAsync(ct);
                cmd.Transaction = tx;
            }
        }

        var requiredRows = Math.Max(cfg.MinimumRatingRows, (long)Math.Ceiling(currentRows * 0.9));
        if (inserted < requiredRows)
        {
            await tx.RollbackAsync(ct);
            await tx.DisposeAsync();
            await cmd.DisposeAsync();
            throw new InvalidDataException($"IMDb ratings dataset contains {inserted} rows; at least {requiredRows} are required.");
        }

        await tx.CommitAsync(ct); await tx.DisposeAsync(); await cmd.DisposeAsync();

        await using var swap = (SqliteTransaction)await cn.BeginTransactionAsync(ct);
        await using (var swapCmd = cn.CreateCommand())
        {
            swapCmd.Transaction = swap;
            swapCmd.CommandText = "DROP TABLE ratings; ALTER TABLE ratings_next RENAME TO ratings;";
            await swapCmd.ExecuteNonQueryAsync(ct);
        }
        await SetMetaAsync(cn, swap, "ratings_refreshed_at", DateTimeOffset.UtcNow.ToString("O"), ct);
        await SetMetaAsync(cn, swap, "ratings_etag", etag, ct);
        await SetMetaAsync(cn, swap, "ratings_last_modified", lastModified?.ToString("O"), ct);
        await swap.CommitAsync(ct);
    }

    public async Task TouchRefreshAsync(CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync(ct);
        await using var tx = (SqliteTransaction)await cn.BeginTransactionAsync(ct);
        await SetMetaAsync(cn, tx, "ratings_refreshed_at", DateTimeOffset.UtcNow.ToString("O"), ct);
        await tx.CommitAsync(ct);
    }

    public async Task<Metadata> GetMetadataAsync()
    {
        await using var cn = new SqliteConnection(Cs); await cn.OpenAsync();
        long count;
        await using (var cmd = cn.CreateCommand()) { cmd.CommandText = "SELECT COUNT(*) FROM ratings"; count = (long)(await cmd.ExecuteScalarAsync() ?? 0L); }
        var state = await GetRefreshStateAsync(CancellationToken.None);
        return new Metadata(count, state.RefreshedAt?.ToString("O"), state.LastModified?.ToString("O"));
    }

    private static async Task SetMetaAsync(SqliteConnection cn, SqliteTransaction tx, string key, string? value, CancellationToken ct)
    {
        await using var cmd = cn.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO metadata(key,value) VALUES($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
        cmd.Parameters.AddWithValue("$k", key); cmd.Parameters.AddWithValue("$v", (object?)value ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task ExecAsync(SqliteConnection cn, string sql)
    {
        await using var cmd = cn.CreateCommand(); cmd.CommandText = sql; await cmd.ExecuteNonQueryAsync();
    }
}

sealed class TmdbResolver(IHttpClientFactory factory)
{
    public async Task<TmdbResolution> ResolveAsync(string type, long id, CancellationToken ct)
    {
        var client = factory.CreateClient("tmdb");
        var path = type == "tv" ? $"tv/{id}/external_ids" : $"movie/{id}/external_ids";
        using var response = await client.GetAsync(path, ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
            return new TmdbResolution(null, Cacheable: true);
        response.EnsureSuccessStatusCode();
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        var imdbId = json.RootElement.TryGetProperty("imdb_id", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
        return new TmdbResolution(IsImdbId(imdbId) ? imdbId : null, Cacheable: true);
    }

    private static bool IsImdbId(string? value) => value is not null && value.StartsWith("tt", StringComparison.Ordinal) && value.Length > 2 && value[2..].All(char.IsDigit);
}

sealed class RatingsUpdater(IHttpClientFactory factory, Db db, AppConfig cfg, ILogger<RatingsUpdater> log)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task RefreshAsync(bool force, CancellationToken ct)
    {
        if (!await _gate.WaitAsync(0, ct)) return;
        try
        {
            var deletedMisses = await db.DeleteExpiredNegativeMappingsAsync(ct);
            if (deletedMisses > 0)
                log.LogInformation("Deleted {Count} expired TMDB negative mappings.", deletedMisses);

            var state = await db.GetRefreshStateAsync(ct);
            if (!force && state.RefreshedAt is not null && DateTimeOffset.UtcNow - state.RefreshedAt < TimeSpan.FromHours(20)) return;

            var client = factory.CreateClient("imdb");
            using var req = new HttpRequestMessage(HttpMethod.Get, cfg.ImdbRatingsUrl);
            if (!string.IsNullOrWhiteSpace(state.ETag)) req.Headers.TryAddWithoutValidation("If-None-Match", state.ETag);
            if (state.LastModified is not null) req.Headers.IfModifiedSince = state.LastModified;

            log.LogInformation("Checking IMDb ratings dataset...");
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.StatusCode == HttpStatusCode.NotModified)
            {
                await db.TouchRefreshAsync(ct);
                log.LogInformation("IMDb dataset unchanged (304).");
                return;
            }
            resp.EnsureSuccessStatusCode();

            var etag = resp.Headers.ETag?.ToString();
            var modified = resp.Content.Headers.LastModified;
            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            await db.BuildAndSwapRatingsAsync(stream, etag, modified, ct);
            log.LogInformation("IMDb ratings dataset imported successfully.");
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            log.LogError(ex, "IMDb ratings refresh failed; existing ratings remain active.");
        }
        finally { _gate.Release(); }
    }
}

sealed class RatingsRefreshWorker(RatingsUpdater updater, AppConfig cfg, ILogger<RatingsRefreshWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await updater.RefreshAsync(force: false, stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var next = new DateTimeOffset(now.Year, now.Month, now.Day, cfg.RefreshUtcHour, 0, 0, TimeSpan.Zero);
            if (next <= now) next = next.AddDays(1);
            var delay = next - now;
            log.LogInformation("Next IMDb refresh scheduled for {NextUtc}", next);
            await Task.Delay(delay, stoppingToken);
            await updater.RefreshAsync(force: true, stoppingToken);
        }
    }
}
