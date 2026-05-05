import { describe, it, expect } from 'bun:test';
import { convertPlaceholders } from '../../../src/services/database/convertPlaceholders.js';

describe('convertPlaceholders', () => {
  it('replaces bare ? sequentially', () => {
    expect(convertPlaceholders('SELECT ? , ? , ?'))
      .toBe('SELECT $1 , $2 , $3');
  });

  it('preserves ? inside single-quoted literals', () => {
    expect(convertPlaceholders("SELECT 'a?b' , ?"))
      .toBe("SELECT 'a?b' , $1");
  });

  it('handles doubled-quote escapes inside literals', () => {
    expect(convertPlaceholders("SELECT 'don''t?stop' , ?"))
      .toBe("SELECT 'don''t?stop' , $1");
  });

  it('preserves ? inside dollar-quoted strings', () => {
    expect(convertPlaceholders('SELECT $$body?with?marks$$ , ?'))
      .toBe('SELECT $$body?with?marks$$ , $1');
  });

  it('preserves ? inside tagged dollar quotes', () => {
    expect(convertPlaceholders('SELECT $tag$ a?b $tag$ , ?'))
      .toBe('SELECT $tag$ a?b $tag$ , $1');
  });

  it('preserves ? inside double-quoted identifiers', () => {
    expect(convertPlaceholders('SELECT "col?name" , ?'))
      .toBe('SELECT "col?name" , $1');
  });

  it('preserves ? inside line comments', () => {
    expect(convertPlaceholders('SELECT 1 -- ?\nAND ?'))
      .toBe('SELECT 1 -- ?\nAND $1');
  });

  it('preserves ? inside block comments', () => {
    expect(convertPlaceholders('SELECT 1 /* ? */ AND ?'))
      .toBe('SELECT 1 /* ? */ AND $1');
  });

  it('passes through SQL with no ?', () => {
    expect(convertPlaceholders('SELECT 1')).toBe('SELECT 1');
  });

  it('does not rewrite literal $1 already present', () => {
    expect(convertPlaceholders('SELECT $1 , ?'))
      .toBe('SELECT $1 , $1');
  });
});
