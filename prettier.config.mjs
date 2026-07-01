export default {
  plugins: ["prettier-plugin-astro"],
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  overrides: [
    {
      files: "*.astro",
      options: {
        parser: "astro",
      },
    },
  ],
};
