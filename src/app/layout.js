import './globals.css';

export const metadata = {
  title: 'Image Converter',
  description: 'Convert PNG, GIF, JPEG to WEBP format',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}