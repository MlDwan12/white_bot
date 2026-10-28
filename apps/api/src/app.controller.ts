import { Controller, Get, Redirect } from '@nestjs/common';

/** Корень и адрес прежней панели (закладки админов) ведут в панель на `/app`. */
@Controller()
export class AppController {
  @Get(['/', 'panel', 'panel/*path'])
  @Redirect('/app')
  root(): void {}
}
