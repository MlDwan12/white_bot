import { parseVkAuthInput } from './vk-auth-input';

const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('parseVkAuthInput', () => {
  it('достаёт код и state из адреса, где они в запросе', () => {
    expect(
      parseVkAuthInput(
        `https://oauth.vk.com/blank.html?code=${CODE}&state=abc123`,
      ),
    ).toEqual({ kind: 'code', code: CODE, state: 'abc123' });
  });

  it('достаёт код и state из адреса, где они после решётки', () => {
    // Какой из двух видов отдаёт VK на пустой странице, из типов не
    // выяснить, поэтому понимаем оба.
    expect(
      parseVkAuthInput(
        `https://oauth.vk.com/blank.html#code=${CODE}&state=abc123`,
      ),
    ).toEqual({ kind: 'code', code: CODE, state: 'abc123' });
  });

  it('принимает кусок вида code=…&state=… без адреса', () => {
    expect(parseVkAuthInput(`code=${CODE}&state=s1`)).toEqual({
      kind: 'code',
      code: CODE,
      state: 's1',
    });
  });

  it('принимает один голый код, тогда state неизвестен', () => {
    expect(parseVkAuthInput(CODE)).toEqual({
      kind: 'code',
      code: CODE,
      state: null,
    });
  });

  it('терпит пробелы и перенос строки по краям', () => {
    expect(parseVkAuthInput(`  \n${CODE}\n `)).toMatchObject({ code: CODE });
  });

  it('раскодирует процентную запись', () => {
    expect(
      parseVkAuthInput('https://x/blank.html?code=ab%2Bcd1234567&state=s'),
    ).toMatchObject({ code: 'ab+cd1234567' });
  });

  it('распознаёт отказ VK отдельно от «нет кода»', () => {
    // На «я нажал “Запретить”» нельзя отвечать «не нашёл код»: человек не
    // поймёт, что дело не в нём.
    expect(
      parseVkAuthInput(
        'https://oauth.vk.com/blank.html?error=access_denied&error_description=User+denied+your+request',
      ),
    ).toEqual({ kind: 'denied', description: 'User denied your request' });
  });

  it('распознаёт отказ, даже если в том же тексте затесался code=', () => {
    // Если в поле оказались обрывки двух попыток (старая ссылка с кодом и
    // новый отказ), отказ не должен потеряться за проверкой кода.
    expect(
      parseVkAuthInput(
        `code=${CODE.slice(0, 5)}&error=access_denied&error_description=User+denied`,
      ),
    ).toEqual({ kind: 'denied', description: 'User denied' });
  });

  it('отвергает пустое и то, что на код не похоже', () => {
    for (const junk of [
      '',
      '   ',
      'привет',
      'https://oauth.vk.com/blank.html',
    ]) {
      expect(parseVkAuthInput(junk)).toBeNull();
    }
  });

  it('отвергает слишком короткий и слишком длинный код', () => {
    expect(parseVkAuthInput('code=abc&state=s')).toBeNull();
    expect(parseVkAuthInput(`code=${'a'.repeat(600)}`)).toBeNull();
  });
});
