import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { PostTemplatesService } from './post-templates.service';
import {
  CreateTemplateDto,
  PauseTemplateDto,
  UpdateTemplateDto,
} from './dto/create-template.dto';

// Minimal, like the other controllers in this project: enough to drive and
// verify recurring posts. Full CRUD belongs to the panel (Step 8) and
// permission guards to Step 9.
@Controller('post-templates')
export class PostTemplatesController {
  constructor(private readonly templates: PostTemplatesService) {}

  @Post()
  createTemplate(@Body() dto: CreateTemplateDto) {
    return this.templates.createTemplate(dto);
  }

  @Get(':id')
  getTemplate(@Param('id') id: string) {
    return this.templates.getTemplate(id);
  }

  /** Edits apply to future firings only — published occurrences are untouched. */
  @Patch(':id')
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.templates.updateTemplate(id, dto);
  }

  @Post(':id/pause')
  setPaused(@Param('id') id: string, @Body() dto: PauseTemplateDto) {
    return this.templates.setPaused(id, dto.paused);
  }

  /** The child posts this template has produced so far. */
  @Get(':id/occurrences')
  listOccurrences(@Param('id') id: string) {
    return this.templates.listOccurrences(id);
  }
}
