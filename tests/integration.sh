#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
test_root="$(mktemp -d /tmp/lampa-imdb-ratings-tests.XXXXXX)"
fixture_port="${FIXTURE_PORT:-18089}"
app_port="${APP_PORT:-18088}"
app_image="${APP_IMAGE:-}"
dotnet_cmd="${DOTNET_CMD:-dotnet}"
fixture_pid=""
app_pid=""
app_container=""
fixture_bind="127.0.0.1"
fixture_url="http://127.0.0.1:$fixture_port/title.ratings.tsv.gz"

if [[ -n "$app_image" ]]; then
    fixture_bind="0.0.0.0"
    fixture_url="http://host.docker.internal:$fixture_port/title.ratings.tsv.gz"
fi

cleanup() {
    if [[ -n "$app_pid" ]]; then
        kill "$app_pid" 2>/dev/null || true
        wait "$app_pid" 2>/dev/null || true
    fi
    if [[ -n "$app_container" ]]; then
        docker rm --force "$app_container" >/dev/null 2>&1 || true
    fi
    if [[ -n "$fixture_pid" ]]; then
        kill "$fixture_pid" 2>/dev/null || true
        wait "$fixture_pid" 2>/dev/null || true
    fi
    rm -rf "$test_root"
}
trap cleanup EXIT

stop_app() {
    if [[ -n "$app_container" ]]; then
        docker rm --force "$app_container" >/dev/null
        app_container=""
    elif [[ -n "$app_pid" ]]; then
        kill "$app_pid"
        wait "$app_pid" 2>/dev/null || true
        app_pid=""
    fi
}

start_app() {
    local data_dir="$1"
    local minimum_rows="$2"
    if [[ -n "$app_image" ]]; then
        app_container="lampa-imdb-ratings-test-$$"
        docker run --detach --rm \
            --name "$app_container" \
            --publish "127.0.0.1:$app_port:8080" \
            --volume "$data_dir:/data" \
            --env SERVICE_TOKEN="integration-test-token" \
            --env IMDB_RATINGS_URL="$fixture_url" \
            --env MINIMUM_RATING_ROWS="$minimum_rows" \
            "$app_image" >/dev/null
    else
        DATA_DIR="$data_dir" \
        SERVICE_TOKEN="integration-test-token" \
        IMDB_RATINGS_URL="$fixture_url" \
        MINIMUM_RATING_ROWS="$minimum_rows" \
        ASPNETCORE_URLS="http://127.0.0.1:$app_port" \
        "$dotnet_cmd" run --project "$project_root/Server/LampaImdbRatings.csproj" --no-build > "$test_root/app.log" 2>&1 &
        app_pid="$!"
    fi
}

assert_status() {
    local expected="$1"
    shift
    local actual
    actual="$(curl --silent --show-error --output "$test_root/response.json" --write-out '%{http_code}' "$@")"
    if [[ "$actual" != "$expected" ]]; then
        echo "Expected HTTP $expected, got $actual: $(<"$test_root/response.json")" >&2
        exit 1
    fi
}

wait_for_status() {
    local expected="$1"
    local url="$2"
    for _ in {1..80}; do
        local actual
        actual="$(curl --silent --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null || true)"
        if [[ "$actual" == "$expected" ]]; then return 0; fi
        sleep 0.25
    done
    echo "Timed out waiting for HTTP $expected from $url" >&2
    if [[ -n "$app_container" ]]; then
        docker logs --tail 80 "$app_container" >&2 || true
    elif [[ -f "$test_root/app.log" ]]; then
        tail -80 "$test_root/app.log" >&2
    fi
    exit 1
}

mkdir -p "$test_root/fixtures" "$test_root/data-valid" "$test_root/data-invalid"
printf 'tconst\taverageRating\tnumVotes\ntt0000001\t7.5\t1234\n' > "$test_root/fixtures/title.ratings.tsv"
gzip -c "$test_root/fixtures/title.ratings.tsv" > "$test_root/fixtures/title.ratings.tsv.gz"

python3 -m http.server "$fixture_port" --bind "$fixture_bind" --directory "$test_root/fixtures" > "$test_root/fixture.log" 2>&1 &
fixture_pid="$!"

if [[ -z "$app_image" ]]; then
    "$dotnet_cmd" build "$project_root/Server/LampaImdbRatings.csproj" --no-restore > "$test_root/build.log"
fi
start_app "$test_root/data-valid" 1

wait_for_status 200 "http://127.0.0.1:$app_port/health"
assert_status 200 "http://127.0.0.1:$app_port/health/live"
assert_status 401 \
    --header 'Content-Type: application/json' \
    --data '{"items":[{"type":"movie","tmdb":0,"imdb":"tt0000001"}]}' \
    "http://127.0.0.1:$app_port/api/ratings"
assert_status 400 \
    --header 'Content-Type: application/json' \
    --header 'X-Api-Key: integration-test-token' \
    --data '{"items":null}' \
    "http://127.0.0.1:$app_port/api/ratings"
assert_status 200 \
    --header 'Content-Type: application/json' \
    --header 'X-Api-Key: integration-test-token' \
    --data '{"items":[{"type":"movie","tmdb":0,"imdb":"tt0000001"}]}' \
    "http://127.0.0.1:$app_port/api/ratings"
if ! grep -q '"rating":7.5' "$test_root/response.json"; then
    echo "Expected imported IMDb rating in response: $(<"$test_root/response.json")" >&2
    exit 1
fi

stop_app
start_app "$test_root/data-invalid" 2

wait_for_status 200 "http://127.0.0.1:$app_port/health/live"
sleep 1
assert_status 503 "http://127.0.0.1:$app_port/health"

echo "Integration tests passed."
