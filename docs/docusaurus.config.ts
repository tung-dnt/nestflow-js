import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';

const config: Config = {
  title: 'NestflowJS',
  tagline: 'Workflow and State Machines for NestJS',
  favicon: 'img/logo.jpeg',

  // Set the production url of your site here
  url: 'https://nestflow.organit.dev',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'tung-dnt', // Usually your GitHub org/user name.
  projectName: 'nestflow-js', // Usually your repo name.

  onBrokenLinks: 'warn',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/tung-dnt/nestflow-js/tree/main/docs/',
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/logo.jpeg',
    navbar: {
      title: 'NestflowJS',
      logo: {
        alt: 'NestflowJS Logo',
        src: 'img/logo.jpeg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          href: 'https://github.com/tung-dnt/nestflow-js',
          label: 'GitHub',
          position: 'right',
        },
        {
          href: 'https://www.npmjs.com/package/nestflow-js',
          label: 'NPM',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Documentation',
          items: [
            {
              label: 'Quick Start',
              to: '/docs/quick-start',
            },
            {
              label: 'Workflow',
              to: '/docs/concepts/workflow',
            },
            {
              label: 'TransitResult',
              to: '/docs/concepts/transit-result',
            },
            {
              label: 'Adapters',
              to: '/docs/concepts/adapters',
            },
          ],
        },
        {
          title: 'Resources',
          items: [
            {
              label: 'Examples',
              to: '/docs/examples/lambda-order-state-machine',
            },
            {
              label: 'API Reference',
              to: '/docs/api-reference/workflow-module',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/tung-dnt/nestflow-js',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/nestflow-js',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Contributing',
              href: 'https://github.com/tung-dnt/nestflow-js/blob/main/CONTRIBUTING.md',
            },
            {
              label: 'Changelog',
              href: 'https://github.com/tung-dnt/nestflow-js/blob/main/CHANGELOG.md',
            },
            {
              label: 'License',
              href: 'https://github.com/tung-dnt/nestflow-js/blob/main/LICENSE',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Thomas Do (tung-dnt). Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'typescript'],
    },
  },

  plugins: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
    function (_context, _options) {
      return {
        name: 'webpack-alias-plugin',
        configureWebpack(_config, _isServer) {
          return {
            resolve: {
              plugins: [new TsconfigPathsPlugin({ baseUrl: '.' })],
            },
          };
        },
      };
    },
  ],
};

export default config;
