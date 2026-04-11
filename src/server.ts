/**
 * Apollo API Server
 *
 * Phase 9: Fastify + Bree orchestration layer.
 * POST /api/jobs/apollo — accepts targeting filters, returns 202 Accepted immediately.
 * Bree worker runs extraction asynchronously in worker_threads.
 */

import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import Bree from 'bree';
import path from 'path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

// ── Job targeting schema ─────────────────────────────────────────────────────

const TargetingSchema = z.object({
  keywords: z.array(z.string()).optional(),
  titles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  companies: z.array(z.string()).optional(),
});

const CreateJobBodySchema = z.object({
  targeting: TargetingSchema,
});

export type CreateJobInput = z.infer<typeof CreateJobBodySchema>;

// ── Fastify ───────────────────────────────────────────────────────────────────

export const fastify = Fastify({
  logger: {
    level: 'info',
  },
});

fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

// ── Bree ─────────────────────────────────────────────────────────────────────

export const bree = new Bree({
  logger: false, // Fastify handles logging
  root: false,
  jobs: [
    {
      name: 'apollo-worker',
      path: path.join(__dirname, '../dist/worker.js'),
      timeout: false, // no timeout — extraction is open-ended
      interval: false,
    },
  ],
});

// ── Routes ────────────────────────────────────────────────────────────────────

const typed = fastify.withTypeProvider<ZodTypeProvider>();

typed.post<{ Body: CreateJobInput }>(
  '/api/jobs/apollo',
  {
    schema: {
      body: CreateJobBodySchema,
    },
  },
  async (request, reply) => {
    const { targeting } = request.body;
    const jobId = `apollo-${randomUUID()}`;

    // Remove any previous instance before re-adding — keeps jobs array clean (single entry)
    await bree.remove('apollo-worker').catch(() => { /* ignore if not found */ });

    // Dynamically set workerData and run the worker
    await bree.add({
      name: 'apollo-worker',
      path: path.join(__dirname, '../dist/worker.js'),
      worker: { workerData: { jobId, targeting } },
    });

    bree
      .run('apollo-worker')
      .catch((err: unknown) => {
        fastify.log.error({ err, jobId }, 'Bree worker start failed');
      });

    return reply.status(202).send({ jobId, status: 'accepted' });
  },
);

typed.get('/health', async () => ({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startServer(port = 3000): Promise<typeof fastify> {
  await bree.start();
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`Apollo server listening on port ${port}`);
  return fastify;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  fastify.log.info('Shutting down...');
  await fastify.close();
  await bree.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Self-start when run directly ─────────────────────────────────────────────
startServer(3000).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
