import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(private readonly logger: PinoLogger) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Without these, a silent network partition (dropped packets, hung
      // host) leaves queries blocked forever, holding pool clients open —
      // enough stuck health checks alone exhaust the pool and every other
      // DB-dependent request hangs too, even after connectivity returns.
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      query_timeout: 10_000,
    });
    super({ adapter: new PrismaPg(pool) });
    this.pool = pool;
    this.logger.setContext(PrismaService.name);
    // pg-pool emits 'error' for idle-client connection failures (e.g. DB restart,
    // network blip); without a listener Node treats it as an uncaught exception
    // and kills the whole process instead of just failing the next query.
    // Object-first call so pino's err serializer actually captures the stack —
    // @nestjs/common's Logger.error(message, trace) expects `trace` as a
    // string, and silently drops an Error object passed there instead.
    this.pool.on('error', (err) => {
      this.logger.error({ err }, 'Postgres pool idle client error');
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
    await this.pool.end();
  }
}
