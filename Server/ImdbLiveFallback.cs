using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

sealed class ImdbLiveFallback(IHttpClientFactory factory, AppConfig cfg, ILogger<ImdbLiveFallback> log)
{
    private const int PositiveCacheHours = 12;
    private const int NegativeCacheHours = 1;
    private const int MaxTitlesPerGraphQlRequest = 20;
    private const int MaxNetworkTitlesPerBatch = 100;
    private const string CacheTable = "live_ratings_v2";
    private readonly SemaphoreSlim _initGate = new(1, 1);
    private bool _initialized;

    private string Cs => new SqliteConnectionStringBuilder
    {
        DataSource = cfg.DbPath,
        Mode = SqliteOpenMode.ReadWriteCreate,
        Cache = SqliteCacheMode.Shared,
        DefaultTimeout = 30
    }.ToString();

    public async Task FillMissingAsync(Dictionary<string, RatingRow> ratings, IEnumerable<string> imdbIds, CancellationToken ct)
    {
        await EnsureInitializedAsync(ct);

        var missing = imdbIds
            .Where(id => !ratings.ContainsKey(id))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (missing.Length == 0) return;

        var uncached = new List<string>();

        foreach (var imdbId in missing)
        {
            var cached = await GetCachedAsync(imdbId, ct);
            if (cached.IsCached)
            {
                if (cached.Rating is not null)
                    ratings[imdbId] = cached.Rating;
            }
            else
            {
                uncached.Add(imdbId);
            }
        }

        var lookupIds = uncached.Take(MaxNetworkTitlesPerBatch).ToArray();
        foreach (var chunk in lookupIds.Chunk(MaxTitlesPerGraphQlRequest))
        {
            Dictionary<string, RatingRow?> batch;
            try
            {
                batch = await FetchGraphQlRatingsAsync(chunk, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                // Transport, HTTP and malformed GraphQL responses are transient failures.
                // Do not negative-cache them: the next request should be allowed to retry.
                log.LogWarning(ex, "IMDb GraphQL batch fallback failed for {Count} title(s)", chunk.Length);
                continue;
            }

            var found = 0;
            foreach (var imdbId in chunk)
            {
                if (!batch.TryGetValue(imdbId, out var rating))
                {
                    // A successful response must contain every requested alias. Treat an
                    // incomplete response as transient for this title and don't cache it.
                    log.LogWarning("IMDb GraphQL batch response omitted {ImdbId}; not caching", imdbId);
                    continue;
                }

                await PutCachedAsync(imdbId, rating, ct);
                if (rating is not null)
                {
                    ratings[imdbId] = rating;
                    found++;
                    log.LogInformation("IMDb GraphQL fallback resolved {ImdbId}: {Rating} ({Votes} votes)", imdbId, rating.Rating, rating.Votes);
                }
                else
                {
                    log.LogInformation("IMDb GraphQL fallback returned no rating for {ImdbId}", imdbId);
                }
            }

            log.LogInformation("IMDb GraphQL batch completed: {Requested} requested, {Found} rating(s) found", chunk.Length, found);
        }
    }

    private async Task<Dictionary<string, RatingRow?>> FetchGraphQlRatingsAsync(IReadOnlyList<string> imdbIds, CancellationToken ct)
    {
        if (imdbIds.Count == 0) return new Dictionary<string, RatingRow?>(StringComparer.Ordinal);

        var client = factory.CreateClient("imdb-live");
        client.Timeout = TimeSpan.FromSeconds(12);

        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.graphql.imdb.com/");
        req.Headers.UserAgent.ParseAdd("Mozilla/5.0");
        req.Headers.TryAddWithoutValidation("Origin", "https://www.imdb.com");
        req.Headers.Referrer = new Uri("https://www.imdb.com/");

        var query = BuildGraphQlQuery(imdbIds);
        req.Content = new StringContent(JsonSerializer.Serialize(new { query }), Encoding.UTF8, "application/json");

        using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        resp.EnsureSuccessStatusCode();

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        if (doc.RootElement.TryGetProperty("errors", out var errors) &&
            errors.ValueKind == JsonValueKind.Array &&
            errors.GetArrayLength() > 0)
            throw new InvalidDataException("IMDb GraphQL returned errors: " + errors.GetRawText());

        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("IMDb GraphQL response has no data object.");

        var result = new Dictionary<string, RatingRow?>(StringComparer.Ordinal);
        for (var i = 0; i < imdbIds.Count; i++)
        {
            var imdbId = imdbIds[i];
            var alias = "t" + i.ToString(CultureInfo.InvariantCulture);

            if (!data.TryGetProperty(alias, out var title))
                continue;

            if (title.ValueKind == JsonValueKind.Null)
            {
                result[imdbId] = null;
                continue;
            }

            if (title.ValueKind != JsonValueKind.Object ||
                !title.TryGetProperty("ratingsSummary", out var summary) ||
                summary.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                result[imdbId] = null;
                continue;
            }

            if (summary.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException($"IMDb GraphQL returned invalid ratingsSummary for {imdbId}.");

            var rating = ReadDouble(summary, "aggregateRating");
            var votes = ReadLong(summary, "voteCount");
            result[imdbId] = rating is > 0 and <= 10 && votes is > 0
                ? new RatingRow(rating.Value, votes.Value)
                : null;
        }

        return result;
    }

    internal static string BuildGraphQlQuery(IReadOnlyList<string> imdbIds)
    {
        var sb = new StringBuilder("query {");
        for (var i = 0; i < imdbIds.Count; i++)
        {
            var imdbId = imdbIds[i];
            if (!System.Text.RegularExpressions.Regex.IsMatch(imdbId, "^tt\\d+$"))
                throw new ArgumentException($"Invalid IMDb id: {imdbId}", nameof(imdbIds));

            sb.Append(' ')
              .Append('t').Append(i.ToString(CultureInfo.InvariantCulture))
              .Append(": title(id: \"").Append(imdbId)
              .Append("\") { ratingsSummary { aggregateRating voteCount } }");
        }
        sb.Append(" }");
        return sb.ToString();
    }

    private static double? ReadDouble(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) return number;
        if (value.ValueKind == JsonValueKind.String && double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)) return number;
        return null;
    }

    private static long? ReadLong(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)) return number;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.Integer | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out number)) return number;
        return null;
    }

    private async Task EnsureInitializedAsync(CancellationToken ct)
    {
        if (_initialized) return;
        await _initGate.WaitAsync(ct);
        try
        {
            if (_initialized) return;
            await using var cn = new SqliteConnection(Cs);
            await cn.OpenAsync(ct);
            await using var cmd = cn.CreateCommand();
            cmd.CommandText = $"""
                CREATE TABLE IF NOT EXISTS {CacheTable}(
                  imdb_id TEXT PRIMARY KEY,
                  rating REAL NULL,
                  votes INTEGER NULL,
                  expires_at TEXT NOT NULL
                );
                """;
            await cmd.ExecuteNonQueryAsync(ct);
            _initialized = true;
        }
        finally
        {
            _initGate.Release();
        }
    }

    private async Task<CachedLiveRating> GetCachedAsync(string imdbId, CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs);
        await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        cmd.CommandText = $"SELECT rating,votes,expires_at FROM {CacheTable} WHERE imdb_id=$id";
        cmd.Parameters.AddWithValue("$id", imdbId);
        await using var rd = await cmd.ExecuteReaderAsync(ct);
        if (!await rd.ReadAsync(ct)) return new CachedLiveRating(false, null);

        if (!DateTimeOffset.TryParse(rd.GetString(2), out var expiresAt) || expiresAt <= DateTimeOffset.UtcNow)
            return new CachedLiveRating(false, null);

        if (rd.IsDBNull(0) || rd.IsDBNull(1)) return new CachedLiveRating(true, null);
        return new CachedLiveRating(true, new RatingRow(rd.GetDouble(0), rd.GetInt64(1)));
    }

    private async Task PutCachedAsync(string imdbId, RatingRow? rating, CancellationToken ct)
    {
        await using var cn = new SqliteConnection(Cs);
        await cn.OpenAsync(ct);
        await using var cmd = cn.CreateCommand();
        cmd.CommandText = $"""
            INSERT INTO {CacheTable}(imdb_id,rating,votes,expires_at)
            VALUES($id,$rating,$votes,$expires)
            ON CONFLICT(imdb_id) DO UPDATE SET
              rating=excluded.rating,
              votes=excluded.votes,
              expires_at=excluded.expires_at
            """;
        cmd.Parameters.AddWithValue("$id", imdbId);
        cmd.Parameters.AddWithValue("$rating", rating is null ? DBNull.Value : rating.Rating);
        cmd.Parameters.AddWithValue("$votes", rating is null ? DBNull.Value : rating.Votes);
        var cacheHours = rating is null ? NegativeCacheHours : PositiveCacheHours;
        cmd.Parameters.AddWithValue("$expires", DateTimeOffset.UtcNow.AddHours(cacheHours).ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private sealed record CachedLiveRating(bool IsCached, RatingRow? Rating);
}
