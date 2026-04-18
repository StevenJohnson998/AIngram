const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

const { checkUrl, extractDoi, checkDoiCrossref } = require('../url-checker');

describe('extractDoi', () => {
  test('extracts DOI from ACM URL', () => {
    expect(extractDoi('https://dl.acm.org/doi/10.1145/3442188.3445922')).toBe('10.1145/3442188.3445922');
  });

  test('extracts DOI from Springer URL', () => {
    expect(extractDoi('https://link.springer.com/article/10.1007/s00521-023-08')).toBe('10.1007/s00521-023-08');
  });

  test('extracts DOI from Wiley URL', () => {
    expect(extractDoi('https://onlinelibrary.wiley.com/journal/doi/abs/10.1002/aaai.12345')).toBe('10.1002/aaai.12345');
  });

  test('extracts DOI from doi.org URL', () => {
    expect(extractDoi('https://doi.org/10.1038/s41586-023-06')).toBe('10.1038/s41586-023-06');
  });

  test('returns null for IEEE (special)', () => {
    expect(extractDoi('https://ieeexplore.ieee.org/document/9876543')).toBeNull();
  });

  test('returns null for Nature (special)', () => {
    expect(extractDoi('https://nature.com/articles/s41586-023-06')).toBeNull();
  });

  test('returns null for non-DOI URL', () => {
    expect(extractDoi('https://example.com/page')).toBeNull();
  });

  test('strips query parameters from DOI', () => {
    expect(extractDoi('https://doi.org/10.1038/test?ref=pdf')).toBe('10.1038/test');
  });
});

describe('checkDoiCrossref', () => {
  test('returns true for valid DOI (200)', async () => {
    global.fetch.mockResolvedValue({ status: 200 });
    expect(await checkDoiCrossref('10.1145/3442188')).toBe(true);
  });

  test('returns false for invalid DOI (404)', async () => {
    global.fetch.mockResolvedValue({ status: 404 });
    expect(await checkDoiCrossref('10.1145/fake')).toBe(false);
  });

  test('returns false on network error', async () => {
    global.fetch.mockRejectedValue(new Error('network'));
    expect(await checkDoiCrossref('10.1145/3442188')).toBe(false);
  });

  test('encodes DOI in URL', async () => {
    global.fetch.mockResolvedValue({ status: 200 });
    await checkDoiCrossref('10.1145/test+value');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.crossref.org/works/10.1145%2Ftest%2Bvalue',
      expect.any(Object)
    );
  });
});

describe('checkUrl', () => {
  test('arxiv valid URL returns link_exists', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<html>arXiv:2401.00001 - Valid paper</html>'),
    });
    expect(await checkUrl('https://arxiv.org/abs/2401.00001')).toBe('link_exists');
  });

  test('arxiv fake ID returns dead', async () => {
    global.fetch.mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<html>arXiv ID not recognized</html>'),
    });
    expect(await checkUrl('https://arxiv.org/abs/9999.99999')).toBe('dead');
  });

  test('arxiv 404 returns dead', async () => {
    global.fetch.mockResolvedValue({
      status: 404,
      text: () => Promise.resolve(''),
    });
    expect(await checkUrl('https://arxiv.org/abs/0000.00000')).toBe('dead');
  });

  test('DOI URL delegates to CrossRef', async () => {
    global.fetch.mockResolvedValue({ status: 200 });
    expect(await checkUrl('https://doi.org/10.1145/3442188')).toBe('link_exists');
  });

  test('DOI URL with dead DOI returns dead', async () => {
    global.fetch.mockResolvedValue({ status: 404 });
    expect(await checkUrl('https://doi.org/10.1145/fake')).toBe('dead');
  });

  test('regular URL HEAD 200 returns link_exists', async () => {
    global.fetch.mockResolvedValue({ status: 200 });
    expect(await checkUrl('https://example.com/page')).toBe('link_exists');
  });

  test('regular URL HEAD 301 returns link_exists', async () => {
    global.fetch.mockResolvedValue({ status: 301 });
    expect(await checkUrl('https://example.com/old')).toBe('link_exists');
  });

  test('regular URL HEAD 403 returns unverifiable', async () => {
    global.fetch.mockResolvedValue({ status: 403 });
    expect(await checkUrl('https://sciencedirect.com/article')).toBe('unverifiable');
  });

  test('regular URL HEAD 404 returns dead', async () => {
    global.fetch.mockResolvedValue({ status: 404 });
    expect(await checkUrl('https://example.com/gone')).toBe('dead');
  });

  test('regular URL HEAD 500 returns dead', async () => {
    global.fetch.mockResolvedValue({ status: 500 });
    expect(await checkUrl('https://example.com/broken')).toBe('dead');
  });

  test('network error returns unverifiable', async () => {
    global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await checkUrl('https://unreachable.example.com')).toBe('unverifiable');
  });

  test('timeout returns unverifiable', async () => {
    global.fetch.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    expect(await checkUrl('https://slow.example.com', 100)).toBe('unverifiable');
  });

  test('IEEE URL (special DOI) falls through to HEAD', async () => {
    global.fetch.mockResolvedValue({ status: 403 });
    expect(await checkUrl('https://ieeexplore.ieee.org/document/9876543')).toBe('unverifiable');
  });
});
