---
name: glassmorphism
description: Production-grade design and engineering guide for semi-transparent glass, frosted glass (Glassmorphism), backdrop-blur, liquid glass, and fluted glass effects in modern React, Tailwind CSS, and pure CSS. Use when designing or implementing glass cards, translucent modals, frosted navbars, blur overlays, chromatic refraction, or glossy UI components.
---

# Glassmorphism & Backdrop-Blur Engineering Guide

This skill provides comprehensive architectural patterns, CSS/Tailwind recipes, accessibility rules, performance optimizations, and React component architectures for modern glassmorphism (frosted glass, semi-translucent surfaces, backdrop-filter blur, fluted glass, and liquid glass).

---

## 1. Core Visual Principles of Authentic Glassmorphism

A convincing glass effect requires four synchronized optical properties:

1. **Translucency (Alpha Transparencies)**:
   - Light theme: `rgba(255, 255, 255, 0.45)` to `rgba(255, 255, 255, 0.75)`
   - Dark theme: `rgba(15, 23, 42, 0.55)` to `rgba(30, 41, 59, 0.75)`
   - Deep glass: Multiple translucent gradient stops (e.g., top-left light catch to bottom-right shadow)

2. **Backdrop Filtration (Blur & Saturation)**:
   - `backdrop-filter: blur(12px) saturate(160%)`
   - Blurring alone washes out colors behind the pane. Adding `saturate(140%-180%)` restores vibrant light transmission.

3. **Specular Edge Lighting (The 1px Bevel / Refraction Border)**:
   - Real glass catches light at the perimeter. Use a translucent border or gradient border:
   - Light: `border: 1px solid rgba(255, 255, 255, 0.35)`
   - Dark: `border: 1px solid rgba(255, 255, 255, 0.12)`
   - Inner highlight: `box-shadow: inset 0 1px 1px 0 rgba(255, 255, 255, 0.25)`

4. **Multi-Elevation Ambient Shadow**:
   - Glass casts soft, spread-out shadows, not sharp black ones:
   - Light: `box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.12)`
   - Dark: `box-shadow: 0 10px 40px 0 rgba(0, 0, 0, 0.45)`

---

## 2. Tailwind CSS Reference Classes

| Glass Style | Tailwind CSS Composition |
| :--- | :--- |
| **Subtle Frosted Card** (Light) | `bg-white/60 backdrop-blur-md backdrop-saturate-150 border border-white/40 shadow-lg shadow-black/5` |
| **Elevated Modal** (Light) | `bg-white/80 backdrop-blur-xl backdrop-saturate-180 border border-white/60 shadow-2xl shadow-indigo-950/10` |
| **Dark Cyber Glass** | `bg-slate-900/60 backdrop-blur-lg backdrop-saturate-150 border border-white/10 shadow-xl shadow-black/40` |
| **Vibrant Neon Tint** | `bg-indigo-500/10 backdrop-blur-md border border-indigo-400/20 shadow-lg shadow-indigo-500/10` |
| **Floating Glass Navbar** | `sticky top-0 z-50 bg-white/70 dark:bg-slate-950/70 backdrop-blur-md border-b border-black/5 dark:border-white/10` |

---

## 3. High-Fidelity CSS Specifications

### Modern Standard Glass Surface
```css
.glass-panel {
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.4) 0%,
    rgba(255, 255, 255, 0.15) 100%
  );
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.3);
  box-shadow: 
    0 8px 32px 0 rgba(0, 0, 0, 0.08),
    inset 0 1px 1px 0 rgba(255, 255, 255, 0.5);
  border-radius: 1rem;
}
```

### Dark Mode Glass Surface
```css
.glass-panel-dark {
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.08) 0%,
    rgba(255, 255, 255, 0.02) 100%
  ), rgba(15, 23, 42, 0.65);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 
    0 12px 40px -10px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 0 rgba(255, 255, 255, 0.15);
  border-radius: 1rem;
}
```

---

## 4. Advanced Effects: Liquid Glass & Fluted Glass

### Fluted (Ribbed) Glass Pattern
Fluted glass refracts vertical strips of background content:
```css
.fluted-glass {
  position: relative;
  background: rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(10px) contrast(110%);
  -webkit-backdrop-filter: blur(10px) contrast(110%);
}

.fluted-glass::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.12) 0px,
    rgba(255, 255, 255, 0.02) 4px,
    rgba(0, 0, 0, 0.04) 5px,
    transparent 8px
  );
  mix-blend-mode: overlay;
}
```

### Liquid Glass Refraction (SVG Displacement Filter)
Inject an inline SVG filter in the root layout to bend light around borders:
```html
<svg class="sr-only" aria-hidden="true">
  <filter id="glass-refraction">
    <feTurbulence type="fractalNoise" baseFrequency="0.02 0.05" numOctaves="2" result="noise" />
    <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
  </filter>
</svg>
```

---

## 5. Performance, Compatibility & Accessibility

### Performance Rules
1. **GPU Layering**:
   - Apply `transform: translateZ(0)` or `will-change: transform` to force a dedicated composite layer and eliminate re-rasterization during scrolling.
2. **Avoid Heavy Nesting**:
   - Never stack more than 2 layers with `backdrop-filter: blur()` over one another. Each blur layer forces an offscreen framebuffer read and convolution pass on the GPU.
3. **Limit High Blur Radii on Low-End Mobile**:
   - Blurs above `24px` can drop FPS on mobile devices. Use responsive blurs: `backdrop-blur-sm md:backdrop-blur-lg`.

### Fallback for Unsupported Browsers
```css
.glass-card {
  /* Fallback solid background */
  background: #ffffff;
  border: 1px solid #e2e8f0;
}

@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  .glass-card {
    background: rgba(255, 255, 255, 0.65);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-color: rgba(255, 255, 255, 0.35);
  }
}
```

### Accessibility (WCAG 2.1 Contrast)
- Because background contents shift behind glass, text contrast must be measured against the **lightest** or **darkest** underlying state.
- Always enforce high-contrast foreground text:
  - In light glass: Use solid high-contrast text (`text-slate-900` or `text-gray-950`).
  - In dark glass: Use bright text (`text-white` or `text-slate-50`).
- For modal dialogs, use a semi-opaque backdrop under the glass modal (`bg-black/40 backdrop-blur-sm`) to stabilize the background luminosity before rendering the glass modal on top.

---

## 6. Production React Component Blueprint

```tsx
import React, { HTMLAttributes } from 'react';

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'subtle' | 'standard' | 'elevated' | 'tinted';
  children: React.ReactNode;
  className?: string;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  variant = 'standard',
  children,
  className = '',
  ...props
}) => {
  const variantStyles = {
    subtle: 'bg-white/40 dark:bg-slate-900/40 backdrop-blur-sm border-white/20 dark:border-white/5',
    standard: 'bg-white/65 dark:bg-slate-900/65 backdrop-blur-md backdrop-saturate-150 border-white/30 dark:border-white/10 shadow-xl shadow-black/5',
    elevated: 'bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl backdrop-saturate-180 border-white/50 dark:border-white/15 shadow-2xl shadow-indigo-950/10',
    tinted: 'bg-primary/10 dark:bg-primary/20 backdrop-blur-lg border-primary/25 shadow-lg shadow-primary/10',
  };

  return (
    <div
      className={`
        relative rounded-2xl border transition-all duration-300
        [transform:translateZ(0)]
        ${variantStyles[variant]}
        ${className}
      `}
      {...props}
    >
      {/* Specular Top Edge Light Inset */}
      <div 
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" 
        aria-hidden="true" 
      />
      {children}
    </div>
  );
};
```
