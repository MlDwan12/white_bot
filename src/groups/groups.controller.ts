import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { GroupsService } from './groups.service';
import { CreateVkGroupDto } from './dto/create-vk-group.dto';
import { UpdateGroupTagsDto } from './dto/update-group-tags.dto';
import { ConfirmMaxGroupDto } from './dto/confirm-max-group.dto';
import { ReplaceVkTokenDto } from './dto/replace-vk-token.dto';

// No permission guards yet — Step 9 (panel auth) wires groups.manage /
// groups.tags.edit / groups.pendingMax.review here. Not exposed publicly
// before then.
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @Post('vk')
  createVkGroup(@Body() dto: CreateVkGroupDto) {
    return this.groupsService.createVkGroup(dto);
  }

  @Post(':id/vk-token')
  replaceVkToken(@Param('id') id: string, @Body() dto: ReplaceVkTokenDto) {
    return this.groupsService.replaceVkToken(id, dto.token);
  }

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
  @Get('max/pending')
  listPendingMaxGroups() {
    return this.groupsService.listPendingMaxGroups();
  }

  @Get(':id')
  getGroup(@Param('id') id: string) {
    return this.groupsService.getGroup(id);
  }

  @Patch(':id/tags')
  updateTags(@Param('id') id: string, @Body() dto: UpdateGroupTagsDto) {
    return this.groupsService.updateTags(id, dto.tags);
  }

  @Post(':id/deactivate')
  deactivate(@Param('id') id: string) {
    return this.groupsService.deactivate(id);
  }

  @Post(':id/max/confirm')
  confirmMaxGroup(@Param('id') id: string, @Body() dto: ConfirmMaxGroupDto) {
    return this.groupsService.confirmMaxGroup(id, dto.tags);
  }

  @Post(':id/max/reject')
  rejectMaxGroup(@Param('id') id: string) {
    return this.groupsService.rejectMaxGroup(id);
  }
}
