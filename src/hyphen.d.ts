declare module 'hyphen/en-us' {
  const en: {
    hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
  };
  export default en;
}
