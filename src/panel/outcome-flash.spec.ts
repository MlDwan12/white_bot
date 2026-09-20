import { outcomeFlash } from './panel.controller';

describe('outcomeFlash', () => {
  it('reports plain success when nothing failed', () => {
    expect(outcomeFlash({ succeeded: 3, failed: [] }, 'deleted')).toBe(
      'deleted',
    );
  });

  it('calls a partial result partial', () => {
    // Сказать «готово» значило бы соврать, а «ошибка» — скрыть, что в
    // остальных группах всё получилось.
    expect(outcomeFlash({ succeeded: 2, failed: [{}] }, 'deleted')).toBe(
      'partial',
    );
  });

  it('does not call a zero-work edit a success', () => {
    // Случается, когда последнюю доставку удалили между отрисовкой страницы
    // и отправкой формы. «Текст обновлён во всех группах» было бы неправдой.
    expect(outcomeFlash({ succeeded: 0, failed: [] }, 'edited')).toBe(
      'nothing-done',
    );
  });

  it('calls a total failure a failure', () => {
    expect(outcomeFlash({ succeeded: 0, failed: [{}, {}] }, 'edited')).toBe(
      'failed',
    );
  });
});
