using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

sealed class ImdbLiveFallback(IHttpClientFactory factory, AppConfig cfg, ILogger<ImdbLiveFallback> log)
{
    private const int CacheHours = 1;
    private const int MaxNetworkLookupsPerBatch = 12;
    private const int MaxParallelism = 3;
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

        var resolved = new ConcurrentDictionary<string, RatingRow>(StringComparer.Ordinal);
        var uncached = new List<string>();

        foreach (var imdbId in missing)
        {
            var cached = await GetCachedAsync(imdbId, ct);
            if (cached.IsCached)
            {
                if (cached.Rating is not null) resolved[imdbId] = cached.Rating;
            }
            else
            {
                uncached.Add(imdbId);
            }
        }

        var lookupIds = uncached.Take(MaxNetworkLookupsPerBatch).ToArray();
        if (lookupIds.Length > 0)
        {
            await Parallel.ForEachAsync(
                lookupIds,
                new ParallelOptions { MaxDegreeOfParallelism = MaxParallelism, CancellationToken = ct },
                async (imdbId, itemCt) =>
                {
                    RatingRow? rating = null;
                    try
                    {
                        rating = await FetchLiveRatingAsync(imdbId, itemCt);
                    }
                    catch (Exception ex) when (!itemCt.IsCancellationRequested)
                    {
                        log.LogWarning(ex, "IMDb live fallback failed for {ImdbId}", imdbId);
                    }

                    await PutCachedAsync(imdbId, rating, itemCt);
                    if (rating is not null) resolved[imdbId] = rating;
                });
        }

        foreach (var pair in resolved)
            ratings[pair.Key] = pair.Value;
    }

    private async Task<RatingRow?> FetchLiveRatingAsync(string imdbId, CancellationToken ct)
    {
        try
        {
            var graphQl = await FetchGraphQlRatingAsync(imdbId, ct);
            if (graphQl is not null)
            {
                log.LogInformation("IMDb GraphQL fallback resolved {ImdbId}: {Rating} ({Votes} votes)", imdbId, graphQl.Rating, graphQl.Votes);
                return graphQl;
            }

            log.LogInformation("IMDb GraphQL fallback returned no rating for {ImdbId}", imdbId);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            log.LogWarning(ex, "IMDb GraphQL fallback failed for {ImdbId}; trying HTML fallback", imdbId);
        }

        return await FetchHtmlRatingAsync(imdbId, ct);
    }

    private async Task<RatingRow?> FetchGraphQlRatingAsync(string imdbId, CancellationToken ct)
    {
        var client = factory.CreateClient("imdb-live");
        client.Timeout = TimeSpan.FromSeconds(12);

        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.graphql.imdb.com/");
        req.Headers.UserAgent.ParseAdd("Mozilla/5.0");
        req.Headers.TryAddWithoutValidation("Origin", "https://www.imdb.com");
        req.Headers.Referrer = new Uri("https://www.imdb.com/");

        var query = $"query {{ title(id: \"{imdbId}\") {{ ratingsSummary {{ aggregateRating voteCount }} }} }}";
        req.Content = new StringContent(JsonSerializer.Serialize(new { query }), Encoding.UTF8, "application/json");

        using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        resp.EnsureSuccessStatusCode();

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);

        if (doc.RootElement.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
            throw new InvalidDataException("IMDb GraphQL returned errors: " + errors.GetRawText());

        if (!doc.RootElement.TryGetProperty("data", out var data) ||
            data.ValueKind != JsonValueKind.Object ||
            !data.TryGetProperty("title", out var title) ||
            title.ValueKind != JsonValueKind.Object ||
            !title.TryGetProperty("ratingsSummary", out var summary) ||
            summary.ValueKind != JsonValueKind.Object)
            return null;

        var rating = ReadDouble(summary, "aggregateRating");
        var votes = ReadLong(summary, "voteCount");
        return rating is > 0 and <= 10 && votes is > 0
            ? new RatingRow(rating.Value, votes.Value)
            : null;
    }

    private async Task<RatingRow?> FetchHtmlRatingAsync(string imdbId, CancellationToken ct)
    {
        var client = factory.CreateClient("imdb-live");
        client.Timeout = TimeSpan.FromSeconds(12);

        using var req = new HttpRequestMessage(HttpMethod.Get, $"https://www.imdb.com/title/{imdbId}/");
        req.Headers.UserAgent.ParseAdd("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36");
        req.Headers.Accept.ParseAdd("text/html,application/xhtml+xml");
        req.Headers.AcceptLanguage.ParseAdd("en-US,en;q=0.9");

        using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseContentRead, ct);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        resp.EnsureSuccessStatusCode();

        var html = await resp.Content.ReadAsStringAsync(ct);
        var rating = ParseStructuredRating(html);
        if (rating is not null)
            log.LogInformation("IMDb HTML fallback resolved {ImdbId}: {Rating} ({Votes} votes)", imdbId, rating.Rating, rating.Votes);
        else
            log.LogInformation("IMDb live fallback found no rating for {ImdbId}", imdbId);
        return rating;
    }

    internal static RatingRow? ParseStructuredRating(string html)
    {
        foreach (Match match in Regex.Matches(
                     html,
                     "<script[^>]+type=[\\\"']application/ld\\+json[\\\"'][^>]*>(.*?)</script>",
                     RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            var jsonText = WebUtility.HtmlDecode(match.Groups[1].Value.Trim());
            if (string.IsNullOrWhiteSpace(jsonText)) continue;

            try
            {
                using var doc = JsonDocument.Parse(jsonText);
                var found = FindAggregateRating(doc.RootElement);
                if (found is not null) return found;
            }
            catch (JsonException)
            {
                // Ignore malformed structured-data blocks and continue with the next one.
            }
        }

        return null;
    }

    private static RatingRow? FindAggregateRating(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            if (element.TryGetProperty("aggregateRating", out var aggregate) && aggregate.ValueKind == JsonValueKind.Object)
            {
                var rating = ReadDouble(aggregate, "ratingValue");
                var votes = ReadLong(aggregate, "ratingCount");
                if (rating is > 0 and <= 10 && votes is > 0)
                    return new RatingRow(rating.Value, votes.Value);
            }

            foreach (var property in element.EnumerateObject())
            {
                var found = FindAggregateRating(property.Value);
                if (found is not null) return found;
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
            {
                var found = FindAggregateRating(item);
                if (found is not null) return found;
            }
        }

        return null;
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
        cmd.Parameters.AddWithValue("$expires", DateTimeOffset.UtcNow.AddHours(CacheHours).ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private sealed record CachedLiveRating(bool IsCached, RatingRow? Rating);
}
