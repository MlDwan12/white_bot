import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaxModule } from '../max/max.module';
import { ContestParticipationModule } from './contest-participation.module';
import { ContestsController } from './contests.controller';
import { MiniAppController } from './miniapp.controller';
import { MiniAppService } from './miniapp.service';
import { ContestsService } from './contests.service';
import { ContestNotifier } from './contest-notifier';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, PrismaModule, MaxModule, ContestParticipationModule],
  controllers: [ContestsController, MiniAppController],
  providers: [ContestsService, ContestNotifier, MiniAppService],
  exports: [ContestsService],
})
export class ContestsModule {}
