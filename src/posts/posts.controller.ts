import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';
import { DeletePublishedDto, EditPublishedDto } from './dto/moderate-post.dto';
import { PostModerationService } from './post-moderation.service';

// Deliberately minimal: enough to drive the delivery pipeline end to end and
// to verify it against real VK groups. The full post CRUD belongs to the web
// panel (Step 8).
//
// Право одно на весь контроллер: посты — единая область, и дробить её на
// «создать» и «остановить» значило бы выдавать половину рычага от кампании.
@Controller('posts')
@UseGuards(AdminAuthGuard, CsrfGuard)
@RequirePermissions('posts_manage')
export class PostsController {
  constructor(
    private readonly postsService: PostsService,
    private readonly moderation: PostModerationService,
  ) {}

  @Post()
  createPost(@Body() dto: CreatePostDto) {
    return this.postsService.createPost(dto);
  }

  /** Hands the campaign to the queue — immediately, or at `scheduledAt`. */
  @Post(':id/schedule')
  schedulePost(@Param('id') id: string) {
    return this.postsService.schedulePost(id);
  }

  @Post(':id/stop')
  stopPost(@Param('id') id: string) {
    return this.postsService.stopPost(id);
  }

  /** "Отправить оставшимся" — retries only what didn't get through. */
  @Post(':id/resume')
  resumePost(@Param('id') id: string) {
    return this.postsService.resumePost(id);
  }

  /**
   * Удаление уже опубликованного — отдельное действие, а не следствие стопа:
   * остановить рассылку и снести то, что люди уже увидели, — разные решения.
   */
  @Post(':id/delete-published')
  deletePublished(@Param('id') id: string, @Body() dto: DeletePublishedDto) {
    return this.moderation.deletePublished(id, dto.groupIds);
  }

  /**
   * Правка опубликованного. Подтверждения на проталкивание нет намеренно —
   * это и есть смысл действия: текст меняется везде, где пост уже вышел.
   */
  @Post(':id/edit-published')
  editPublished(@Param('id') id: string, @Body() dto: EditPublishedDto) {
    return this.moderation.editPublished(id, dto);
  }

  @Get(':id')
  getPost(@Param('id') id: string) {
    return this.postsService.getPostWithDeliveries(id);
  }
}
