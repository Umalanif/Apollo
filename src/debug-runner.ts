import { createCrawler } from './crawler';
import { logger } from './logger';

async function main() {
  const jobId = 'debug-test-' + Date.now();
  
  logger.info({ jobId }, 'DEBUG: Starting headful crawler test');
  
  const crawler = await createCrawler({
    jobId,
    proxyPort: 10000,
    onChallengeDetected: async (detection, url, _page) => {
      logger.warn({ jobId, detection: detection.type, url }, 'Challenge detected');
    },
    onPageReady: async (_page, url) => {
      logger.info({ jobId, url }, 'Page ready');
    },
  });

  await crawler.run([{
    url: 'https://app.apollo.io/#/people?search[title]=engineer&search[locations][]=United+States',
  }]);
  
  await crawler.teardown();
  logger.info({ jobId }, 'DEBUG: Done');
}

main().catch(console.error);
