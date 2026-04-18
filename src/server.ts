import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { WorkerOptions } from 'node:worker_threads';
import Bree from 'bree';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { logger } from './logger';
import { TargetingSchema } from './targeting';

const CreateJobBodySchema = z.object({
  targeting: TargetingSchema,
});

export type CreateJobInput = z.infer<typeof CreateJobBodySchema>;

function resolveWorkerRuntime(): { workerPath: string; workerOptions: WorkerOptions; acceptedExtensions: string[] } {
  const isTypeScriptRuntime = path.extname(__filename) === '.ts';

  if (isTypeScriptRuntime) {
    return {
      workerPath: path.join(__dirname, 'worker.ts'),
      workerOptions: {
        execArgv: ['--import', 'tsx'],
      },
      acceptedExtensions: ['.js', '.mjs', '.ts'],
    };
  }

  return {
    workerPath: path.join(__dirname, 'worker.js'),
    workerOptions: {},
    acceptedExtensions: ['.js', '.mjs'],
  };
}

function createApolloWorkerJob(input: CreateJobInput, jobId: string) {
  const runtime = resolveWorkerRuntime();

  return {
    name: 'apollo-worker',
    path: runtime.workerPath,
    worker: {
      ...runtime.workerOptions,
      workerData: {
        jobId,
        targeting: input.targeting,
      },
    },
  };
}

export function createApp() {
  const runtime = resolveWorkerRuntime();

  const fastify = Fastify({
    logger,
  });

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  const bree = new Bree({
    logger: false,
    root: false,
    acceptedExtensions: runtime.acceptedExtensions,
    worker: runtime.workerOptions,
    workerMessageHandler: ({ name, message, worker }) => {
      fastify.log.info({ workerName: name, worker, message }, 'Worker message received');
    },
    errorHandler: (error, data) => {
      fastify.log.error({ err: error, worker: data.worker, workerName: data.name }, 'Bree worker failed');
    },
  });

  const typed = fastify.withTypeProvider<ZodTypeProvider>();

  typed.post<{ Body: CreateJobInput }>(
    '/api/jobs/apollo',
    {
      schema: {
        body: CreateJobBodySchema,
      },
    },
    async (request, reply) => {
      const jobId = `apollo-${randomUUID()}`;

      await bree.remove('apollo-worker').catch(() => undefined);
      await bree.add(createApolloWorkerJob(request.body, jobId));

      void bree.run('apollo-worker').catch((err: unknown) => {
        fastify.log.error({ err, jobId }, 'Bree worker start failed');
      });

      return reply.status(202).send({ jobId, status: 'accepted' });
    },
  );

  typed.get('/health', async () => ({ status: 'ok' }));

  let started = false;

  async function start(port = 3000): Promise<void> {
    if (started) {
      return;
    }

    await bree.start();
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(
      {
        port,
        workerPath: runtime.workerPath,
        workerRuntime: path.extname(runtime.workerPath),
      },
      'Apollo server started',
    );
    started = true;
  }

  async function stop(): Promise<void> {
    if (!started) {
      return;
    }

    fastify.log.info('Apollo shutdown started');
    await fastify.close();
    await bree.stop();
    started = false;
  }

  return {
    fastify,
    bree,
    start,
    stop,
  };
}
