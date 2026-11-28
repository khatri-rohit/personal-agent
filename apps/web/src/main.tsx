import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './app/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';

import ChatThreadPage from '@/app/chat-page';
import HomePage from '@/app/home-page';
import { Providers } from '@/components/shell/providers';

/** `/chat/:threadId`, keyed so a thread switch mounts a fresh page (as Next did per route). */
function ChatRoute() {
  const { threadId = '' } = useParams();
  return <ChatThreadPage key={threadId} threadId={threadId} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Providers>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/chat/:threadId" element={<ChatRoute />} />
          <Route path="*" element={<p className="p-8 text-sm text-muted-foreground">This page could not be found.</p>} />
        </Routes>
      </Providers>
    </BrowserRouter>
  </StrictMode>,
);
