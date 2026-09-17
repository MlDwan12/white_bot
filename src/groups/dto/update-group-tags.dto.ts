import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class UpdateGroupTagsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  tags: string[];
}
