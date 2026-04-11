import urllib.request
import json

data = {
    "targeting": {
        "titles": ["engineer"],
        "locations": ["United States"]
    }
}

req = urllib.request.Request(
    'http://localhost:3000/api/jobs/apollo',
    data=json.dumps(data).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
    method='POST'
)

try:
    with urllib.request.urlopen(req, timeout=10) as response:
        result = response.read().decode('utf-8')
        print(f'Response: {response.status} - {result}')
except Exception as e:
    print(f'Error: {e}')