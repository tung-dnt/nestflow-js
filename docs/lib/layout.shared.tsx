import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-bold">
          <img src="/img/logo.jpeg" alt="NestflowJS Logo" width={28} height={28} className="rounded" />
          NestflowJS
        </span>
      ),
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs/introduction',
      },
      {
        text: 'API Reference',
        url: '/docs/api-reference/workflow-module',
      },
      // {
      //   text: 'GitHub',
      //   url: 'https://github.com/tung-dnt/nestflow-js',
      //   external: true,
      // },
      // {
      //   text: 'NPM',
      //   url: 'https://www.npmjs.com/package/nestflow-js',
      //   external: true,
      // },
    ],
  };
}
