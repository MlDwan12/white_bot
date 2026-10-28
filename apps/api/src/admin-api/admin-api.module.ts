import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContestsModule } from '../contests/contests.module';
import { PostsModule } from '../posts/posts.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GroupsModule } from '../groups/groups.module';
import { MediaModule } from '../media/media.module';
import { DirectMessagesModule } from '../direct-messages/direct-messages.module';
import { PlatformUsersModule } from '../platform-users/platform-users.module';
import { VkModule } from '../vk/vk.module';
import { AdminsModule } from '../admins/admins.module';
import { ContestsApiController } from './contests-api.controller';
import { GroupsApiController } from './groups-api.controller';
import { MediaApiController } from './media-api.controller';
import { PostsApiController } from './posts-api.controller';
import { TemplatesApiController } from './templates-api.controller';
import { AdminsApiController } from './admins-api.controller';
import { StatsApiController } from './stats-api.controller';

/** JSON-API React-панели (`web/`), под `/api`. */
@Module({
  imports: [
    AuthModule,
    PrismaModule,
    PostsModule,
    ContestsModule,
    GroupsModule,
    MediaModule,
    DirectMessagesModule,
    PlatformUsersModule,
    VkModule,
    AdminsModule,
  ],
  controllers: [
    ContestsApiController,
    GroupsApiController,
    MediaApiController,
    PostsApiController,
    TemplatesApiController,
    AdminsApiController,
    StatsApiController,
  ],
})
export class AdminApiModule {}
