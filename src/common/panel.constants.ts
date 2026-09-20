/**
 * Префикс, под которым живёт веб-панель.
 *
 * По нему отличаются страницы от API, и это осознанно **одно** правило, а не
 * два: и конверт `{success,data}`, и обработчик ошибок должны понимать, что
 * отвечать — JSON или HTML. Разные признаки в этих двух местах рано или
 * поздно разошлись бы, и страница отдавала бы JSON ровно там, где человек
 * ждёт экран с ошибкой.
 */
export const PANEL_PREFIX = '/panel';

export function isPanelRequest(path: string | undefined): boolean {
  return (path ?? '').startsWith(PANEL_PREFIX);
}
