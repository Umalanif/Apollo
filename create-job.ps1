$body = @"
{"targeting":{"titles":["engineer"],"locations":["United States"]}}
"@
$response = Invoke-RestMethod -Uri 'http://localhost:3000/api/jobs/apollo' -Method Post -Body $body -ContentType 'application/json'
$response | ConvertTo-Json