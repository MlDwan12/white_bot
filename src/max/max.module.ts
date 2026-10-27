import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GroupsModule } from '../groups/groups.module';
import { ContestParticipationModule } from '../contests/contest-participation.module';
import { PlatformUsersModule } from '../platform-users/platform-users.module';
import { MaxCoreModule } from './max-core.module';
import { MaxBotHandlers } from './max-bot.handlers';
import { MaxPollingWorker } from './max-polling.worker';
import { MaxWebAppGuard } from './max-webapp.guard';

@Module({
  imports: [
    PrismaModule,
    GroupsModule,
    ContestParticipationModule,
    PlatformUsersModule,
    MaxCoreModule,
  ],
  providers: [MaxBotHandlers, MaxPollingWorker, MaxWebAppGuard],
  exports: [MaxCoreModule, MaxWebAppGuard],
})
export class MaxModule {}
