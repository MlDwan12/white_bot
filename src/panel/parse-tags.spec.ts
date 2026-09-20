import { parseTags } from './panel.controller';

describe('parseTags', () => {
  it('splits a comma-separated field', () => {
    expect(parseTags('новости, акции')).toEqual(['новости', 'акции']);
  });

  it('drops empty entries and stray spaces', () => {
    // Человек печатает как получится: лишние запятые и пробелы не должны
    // превращаться в теги-пустышки, по которым потом ничего не найдётся.
    expect(parseTags('  новости ,, акции ,  ')).toEqual(['новости', 'акции']);
  });

  it('treats an empty field as no tags', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
  });

  it('keeps a single tag without a comma', () => {
    expect(parseTags('новости')).toEqual(['новости']);
  });
});
