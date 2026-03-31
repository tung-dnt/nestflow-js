import { createMDX } from 'fumadocs-mdx/next';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  images: {
    unoptimized: false,
  },
};

const withMDX = createMDX();

export default withMDX(config);
