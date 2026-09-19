import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MaxModule } from '../max/max.module';
import { ContestParticipationModule } from './contest-participation.module';
import { ContestsController } from './contests.controller';
import { ContestsService } from './contests.service';
import { ContestNotifier } from './contest-notifier';

@Module({
  imports: [PrismaModule, MaxModule, ContestParticipationModule],
  controllers: [ContestsController],
  providers: [ContestsService, ContestNotifier],
  exports: [ContestsService],
})
export class ContestsModule {}
