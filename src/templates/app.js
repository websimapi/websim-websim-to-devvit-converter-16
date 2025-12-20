export const getServerMainTsx = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

Devvit.addCustomPostType({
  name: '${title.replace(/'/g, "\\'")}',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    
    const channelName = \`game_\${context.postId || 'global'}\`;
    const channel = useChannel({
      name: channelName,
      onMessage: (msg) => {
        context.ui.webView.postMessage('gameview', {
          type: 'REALTIME_EVENT',
          payload: msg
        });
      },
    });
    
    channel.subscribe();

    const handleWebViewMessage = async (msg: any) => {
      try {
        if (msg.type === 'console') {
          const prefix = '[WebView]';
          const args = [prefix, ...(msg.args || [])];
          if (msg.level === 'error') console.error(...args);
          else if (msg.level === 'warn') console.warn(...args);
          else console.log(...args);
          return;
        }

        if (msg.type === 'DB_SET') {
          const { collection, id, data, reqId } = msg;
          await context.redis.hSet(\`websim:col:\${collection}\`, { 
            [id]: JSON.stringify(data) 
          });
          context.ui.webView.postMessage('gameview', {
            type: 'DB_SET_RESPONSE',
            reqId,
            success: true,
            id
          });
          return;
        }

        if (msg.type === 'DB_GET') {
          const { collection, reqId } = msg;
          const raw = await context.redis.hGetAll(\`websim:col:\${collection}\`);
          const parsed: Record<string, any> = {};
          for (const [k, v] of Object.entries(raw || {})) {
            try { parsed[k] = JSON.parse(v); } catch (e) { parsed[k] = v; }
          }
          context.ui.webView.postMessage('gameview', {
            type: 'DB_GET_RESPONSE',
            reqId,
            data: parsed
          });
          return;
        }

        if (msg.type === 'DB_DELETE') {
          const { collection, id, reqId } = msg;
          await context.redis.hDel(\`websim:col:\${collection}\`, [id]);
          context.ui.webView.postMessage('gameview', {
            type: 'DB_DELETE_RESPONSE',
            reqId,
            success: true
          });
          return;
        }

        if (msg.type === 'REALTIME_SEND') {
          const { event } = msg;
          await context.realtime.send(channelName, event);
          context.ui.webView.postMessage('gameview', {
            type: 'REALTIME_EVENT',
            payload: event
          });
          return;
        }

      } catch (error) {
        console.error('[Devvit Server Error]', error);
        if (msg.reqId) {
          context.ui.webView.postMessage('gameview', {
            type: \`\${msg.type}_RESPONSE\`,
            reqId: msg.reqId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
    };

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url="${webviewPath}"
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={handleWebViewMessage}
        />
        <vstack padding="medium" gap="medium">
          <button icon="refresh" onPress={() => setKey(k => k + 1)}>Reload Game</button>
          <text size="small" color="neutral-content-weak">Running on Reddit Devvit</text>
        </vstack>
      </vstack>
    );
  },
});

Devvit.addMenuItem({
  label: 'Create ${title.replace(/'/g, "\\'")}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${title.replace(/'/g, "\\'")}',
        subredditName: subreddit.name,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle">
            <text size="large">Loading Game...</text>
          </vstack>
        ),
      });
      ui.showToast('Game created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;

