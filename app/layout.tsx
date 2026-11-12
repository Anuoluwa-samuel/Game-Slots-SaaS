import type { Metadata } from 'next'
import { Barlow_Condensed, DM_Mono, Manrope } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'
import { headers } from "next/headers"

// Barlow Condensed is the stadium-board display face for headlines; Manrope is
// the readable body; DM Mono is the uppercase "/LABEL" voice and ticket numbers.
const display = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-barlow', display: 'swap' })
const sans = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' })
const mono = DM_Mono({ subsets: ['latin'], weight: ['300', '400', '500'], variable: '--font-dm-mono', display: 'swap' })

export const metadata: Metadata = {
  title: { default: 'Game Slots — Football Session Tickets', template: '%s · Game Slots' },
  description: 'Book a slot in organised 8-team football sessions. Secure payment, instant digital ticket, QR entry.',
  applicationName: 'Game Slots',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

/**
 * "Desktop site" on a phone makes the browser ignore the viewport meta tag and
 * lay the page out ~980px wide, so everything renders tiny. Before first paint,
 * detect a touch screen narrower than a tablet showing a wider layout, zoom
 * <html> back to the screen's real width and flag it; globals.css then points
 * every breakpoint at the phone layout. Real desktops and tablets never match.
 */
const phoneZoomScript = `(function(){var d=document.documentElement;function f(){var s=screen.width,w=window.innerWidth;var on=s>0&&s<640&&w>s*1.2&&matchMedia("(pointer: coarse)").matches;if(on){d.style.zoom=String(w/s);d.style.setProperty("--phone-zoom",String(w/s));d.setAttribute("data-phone-zoom","")}else if(d.hasAttribute("data-phone-zoom")){d.style.zoom="";d.style.removeProperty("--phone-zoom");d.removeAttribute("data-phone-zoom")}}f();addEventListener("resize",f)})()`

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Set by the proxy, one per request: the only inline script the policy will
  // run is the one carrying this value.
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // from an inline script before hydration, so the server markup won't match.
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: phoneZoomScript }} />
      </head>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
          // next-themes writes an inline script to set the theme before
          // hydration; without the nonce the policy blocks it and the page
          // flashes the wrong theme.
          nonce={nonce}
        >
          {children}
          <Toaster position="top-center" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  )
}
