import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { PostsModule } from '../posts/posts.module';
import { GroupsModule } from '../groups/groups.module';
import { MediaModule } from '../media/media.module';
import { PanelController } from './panel.controller';
import { SilentRefreshMiddleware } from './silent-refresh.middleware';

@Module({
  imports: [PrismaModule, AuthModule, PostsModule, GroupsModule, MediaModule],
  controllers: [PanelController],
  providers: [SilentRefreshMiddleware],
})
export class PanelModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Только на страницы панели: у API-клиентов есть свой путь обновления
    // сессии, и продлевать её за них молча — значит скрывать от них, что
    // токен истёк.
    consumer.apply(SilentRefreshMiddleware).forRoutes(PanelController);
  }
}
