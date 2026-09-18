import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PostsService } from './posts.service';
import { CreatePostDto } from './dto/create-post.dto';

// Deliberately minimal: enough to drive the delivery pipeline end to end and
// to verify it against real VK groups. The full post CRUD belongs to the web
// panel (Step 8), and permission guards to Step 9 — like GroupsController,
// this isn't exposed publicly before then.
@Controller('posts')
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

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

  @Get(':id')
  getPost(@Param('id') id: string) {
    return this.postsService.getPostWithDeliveries(id);
  }
}
