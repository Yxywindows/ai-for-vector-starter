#!/usr/bin/env bash
# API Learning Lab — curl examples
#
# Run these one at a time (or the whole script) against a running instance:
#   cd api-learning-lab/backend && uvicorn app.main:app --port 8000
#
set -e
BASE_URL="http://localhost:8000"

echo "=== Health check ==="
curl -s "$BASE_URL/api/health"
echo -e "\n"

echo "=== Path Parameter: GET one dataset by id ==="
curl -s "$BASE_URL/api/datasets/1" | python -m json.tool
echo

echo "=== Query Parameter: filter + paginate + sort ==="
curl -s "$BASE_URL/api/datasets?page=1&pageSize=5&keyword=sea&type=ocean-observation&year=2023&status=published&sortBy=price&sortOrder=asc" | python -m json.tool
echo

echo "=== Header Example: write without auth headers -> rejected ==="
curl -i -s -X DELETE "$BASE_URL/api/datasets/1"
echo -e "\n"

echo "=== Request Body: POST create a new dataset (with auth headers) ==="
curl -s -X POST "$BASE_URL/api/datasets" \
  -H "Authorization: Bearer test-token" \
  -H "X-Organization-ID: org-42" \
  -H "Content-Type: application/json" \
  -d '{
        "title": "Example Dataset Created via curl",
        "description": "Created by curl-examples.sh",
        "resourceType": "weather",
        "publishYear": 2026,
        "metadata": {"station": "CURL-EXAMPLE-01", "elevation_m": 10, "variable": "temperature"},
        "tags": ["weather", "example"]
      }' | python -m json.tool
echo

echo "=== Update: PUT path + body together (adjust the id below to one that exists) ==="
curl -s -X PUT "$BASE_URL/api/datasets/61" \
  -H "Authorization: Bearer test-token" \
  -H "X-Organization-ID: org-42" \
  -H "Content-Type: application/json" \
  -d '{"status": "published", "price": 25.00}' | python -m json.tool
echo

echo "=== Delete: DELETE path only (adjust the id below to one that exists) ==="
curl -i -s -X DELETE "$BASE_URL/api/datasets/61" \
  -H "Authorization: Bearer test-token" \
  -H "X-Organization-ID: org-42"
echo -e "\n"

echo "=== Multipart: upload a file to dataset 2 ==="
echo "sample,csv,content" > /tmp/example-upload.csv
curl -s -X POST "$BASE_URL/api/datasets/2/files" \
  -F "file=@/tmp/example-upload.csv" \
  -F "fileType=text/csv" | python -m json.tool
echo

echo "=== List files for dataset 2 ==="
curl -s "$BASE_URL/api/datasets/2/files" | python -m json.tool
