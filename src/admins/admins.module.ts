import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminsService } from './admins.service';

@Module({
  imports: [PrismaModule, AuthModule],
  providers: [AdminsService],
  exports: [AdminsService],
})
export class AdminsModule {}
