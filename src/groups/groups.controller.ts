import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../auth/admin-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { GroupsService } from './groups.service';
import { CreateVkGroupDto } from './dto/create-vk-group.dto';
import { UpdateGroupTagsDto } from './dto/update-group-tags.dto';
import { ConfirmMaxGroupDto } from './dto/confirm-max-group.dto';
import { ReplaceVkTokenDto } from './dto/replace-vk-token.dto';

// Права здесь разные по маршрутам, а не одно на контроллер: `admin` должен
// видеть список групп, чтобы выбрать цели рассылки, но не должен ни заводить
// группы, ни трогать их токены. Общее право свело бы эти случаи в один.
@Controller('groups')
@UseGuards(AdminAuthGuard, CsrfGuard)
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @RequirePermissions('groups_manage')
  @Post('vk')
  createVkGroup(@Body() dto: CreateVkGroupDto) {
    return this.groupsService.createVkGroup(dto);
  }

  @RequirePermissions('groups_tokens_manage')
  @Post(':id/vk-token')
  replaceVkToken(@Param('id') id: string, @Body() dto: ReplaceVkTokenDto) {
    return this.groupsService.replaceVkToken(id, dto.token);
  }

  @RequirePermissions('groups_view')
  @Get()
  listGroups() {
    return this.groupsService.listGroups();
  }

  /**
   * MAX drafts awaiting review. Declared before `:id` for readability (that
   * route only matches a single segment, so there's no actual conflict).
   *
   * This is the fallback the chat buttons need: MAX refuses a bot's first
   * message to a user who never opened a dialog with it, so the notification
   * carrying those buttons can legitimately fail to arrive. Without a way to
   * list pending drafts, such a group would be invisible and unconfirmable.
   */
  @RequirePermissions('groups_pendingMax_review')
  @Get('max/pending')
  listPendingMaxGroups() {
    return this.groupsService.listPendingMaxGroups();
  }

  @RequirePermissions('groups_view')
  @Get(':id')
  getGroup(@Param('id') id: string) {
    return this.groupsService.getGroup(id);
  }

  @RequirePermissions('groups_tags_edit')
  @Patch(':id/tags')
  updateTags(@Param('id') id: string, @Body() dto: UpdateGroupTagsDto) {
    return this.groupsService.updateTags(id, dto.tags);
  }

  @RequirePermissions('groups_manage')
  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.groupsService.deactivate(id);
  }

  @RequirePermissions('groups_pendingMax_review')
  @Post(':id/max/confirm')
  confirmMaxGroup(@Param('id') id: string, @Body() dto: ConfirmMaxGroupDto) {
    return this.groupsService.confirmMaxGroup(id, dto.tags);
  }

  @RequirePermissions('groups_pendingMax_review')
  @Post(':id/max/reject')
  rejectMaxGroup(@Param('id') id: string) {
    return this.groupsService.rejectMaxGroup(id);
  }
}
