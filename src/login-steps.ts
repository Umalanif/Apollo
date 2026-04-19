import { writeFile } from 'node:fs/promises';

import { configureApolloPage } from './apollo-browser';
import { launchApolloContext } from './browser-launch';
import { getMicrosoftCredentials } from './env/schema';
import { warmupApolloSession } from './session-preflight';
import { runMicrosoftApolloLogin } from './services/microsoft-oauth';

interface StepEntry {
  title: string;
  details?: string;
}

function toMarkdown(steps: StepEntry[]): string {
  return steps
    .map((step, index) => {
      const lines = [`#Step${index + 1}`, step.title];
      if (step.details) {
        lines.push(step.details);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

async function main(): Promise<void> {
  const jobId = `login-steps-${Date.now()}`;
  const profileId = `login-steps-${Date.now()}`;
  const context = await launchApolloContext(jobId, { profileId });
  const steps: StepEntry[] = [];

  const recordStep = async (title: string, details?: string): Promise<void> => {
    steps.push({ title, details });
    await writeFile('steps.md', `\uFEFF${toMarkdown(steps)}`, 'utf8');
    console.log(`[login-steps] ${title}${details ? ` (${details})` : ''}`);
  };

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await configureApolloPage(page);
    page.setDefaultNavigationTimeout(120_000);
    page.setDefaultTimeout(120_000);

    const { email, password } = getMicrosoftCredentials();

    await runMicrosoftApolloLogin(page, {
      email,
      password,
      onStep: async (step, message) => {
        switch (step) {
          case 'open-login':
            await recordStep('Открылась страница логина');
            break;
          case 'microsoft-button':
            await recordStep('Клик на Microsoft auth');
            break;
          case 'email':
            await recordStep('Введен email Microsoft аккаунта');
            break;
          case 'use-password':
            await recordStep('Выбран вход по паролю');
            break;
          case 'password':
            await recordStep('Введен пароль Microsoft аккаунта');
            break;
          case 'kmsi':
            await recordStep('Обработан экран Stay signed in', message);
            break;
          case 'apollo-redirect':
            await recordStep('Произошел редирект обратно в Apollo', page.url());
            break;
        }
      },
      onRecoverableStepError: async (step, error) => {
        await recordStep(
          `Предупреждение на шаге ${step}`,
          error instanceof Error ? error.message : String(error),
        );
      },
    });

    await warmupApolloSession(page, jobId);
    await recordStep('Авторизация в Apollo завершена');
  } catch (error) {
    await recordStep(
      'Авторизация завершилась ошибкой',
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    await context.close();
  }
}

void main().catch(error => {
  console.error('[login-steps] Fatal error:', error);
  process.exitCode = 1;
});
