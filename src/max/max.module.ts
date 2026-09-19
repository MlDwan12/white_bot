import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GroupsModule } from '../groups/groups.module';
import { ContestParticipationModule } from '../contests/contest-participation.module';
import { MaxAdminResolver } from './max-admin.resolver';
import { MaxApiClient } from './max-api.client';
import { maxBotProvider } from './max-bot.provider';
import { MaxBotHandlers } from './max-bot.handlers';
import { MaxPollingWorker } from './max-polling.worker';

@Module({
  imports: [PrismaModule, GroupsModule, ContestParticipationModule],
  providers: [
    maxBotProvider,
    MaxApiClient,
    MaxAdminResolver,
    MaxBotHandlers,
    MaxPollingWorker,
  ],
  exports: [MaxApiClient, MaxAdminResolver],
})
export class MaxModule {}
