'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';

export function Hero() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText('pnpm add nestflow-js');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <header className="relative overflow-hidden bg-linear-to-br from-[#1a1a2e] to-[#16213e] px-6 py-24 text-center text-white md:px-8 md:py-32">
      {/* Radial glow overlay */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(224,35,78,0.15)_0%,transparent_60%)]" />

      <div className="relative mx-auto max-w-3xl">
        <h1 className="mb-4 text-4xl font-extrabold leading-tight md:text-5xl">
          Event-driven NestJS{' '}
          <span className="bg-linear-to-r from-[#e0234e] to-[#ff6b6b] bg-clip-text italic text-transparent">
            State Machine
          </span>
        </h1>

        <p className="mx-auto mb-8 max-w-xl text-lg leading-relaxed text-white/80 md:text-xl">
          Business state management with zero dependencies, no vendor lock-in, no infrastructure constraints — just your
          entities and their transitions.
        </p>

        {/* Install command */}
        <button
          onClick={handleCopy}
          className="mb-8 inline-flex cursor-pointer items-center gap-3 rounded-lg border border-white/20 bg-white/10 px-5 py-3 font-mono text-sm text-white/90 transition-colors hover:border-white/30 hover:bg-white/15"
          title="Click to copy"
        >
          <span className="text-white/50 select-none">$</span>
          <span>
            pnpm add <span className="text-[#ff6b6b]">nestflow-js</span>
          </span>
          <svg
            className="h-4 w-4 opacity-60 transition-opacity hover:opacity-100"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            {copied ? (
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </>
            )}
          </svg>
        </button>

        {/* CTA buttons */}
        <div className="mb-6 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <Link
            href="/docs/introduction"
            className="inline-flex items-center gap-2 rounded-lg border-2 border-[#e0234e] bg-[#e0234e] px-7 py-3 font-semibold text-white transition-all hover:-translate-y-0.5 hover:border-[#c5103e] hover:bg-[#c5103e]"
          >
            Get Started
          </Link>
          <a
            href="https://github.com/tung-dnt/nestflow-js"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border-2 border-white/40 bg-transparent px-7 py-3 font-semibold text-white transition-all hover:-translate-y-0.5 hover:border-white/80 hover:bg-white/10"
          >
            GitHub
          </a>
        </div>

        {/* Badges */}
        <div className="flex flex-wrap items-center justify-center gap-3">
          <a href="https://www.npmjs.com/package/nestflow-js">
            <img
              className="h-6"
              src="https://img.shields.io/npm/v/nestflow-js.svg?style=flat-square"
              alt="npm version"
            />
          </a>
          <a href="https://www.npmjs.com/package/nestflow-js">
            <img
              className="h-6"
              src="https://img.shields.io/npm/dm/nestflow-js.svg?style=flat-square"
              alt="npm downloads"
            />
          </a>
          <a href="https://github.com/tung-dnt/nestflow-js/blob/main/LICENSE">
            <img className="h-6" src="https://img.shields.io/npm/l/nestflow-js.svg?style=flat-square" alt="license" />
          </a>
        </div>
      </div>
    </header>
  );
}
