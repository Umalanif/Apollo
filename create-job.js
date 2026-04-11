const http = require('http');

const data = JSON.stringify({
  targeting: {
    titles: ["engineer"],
    locations: ["United States"]
  }
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/jobs/apollo',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Response:', res.statusCode, body);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(data);
req.end();

console.log('Job creation request sent...');