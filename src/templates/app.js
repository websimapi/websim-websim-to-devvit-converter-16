export const getServerMainTsx = (title, webviewPath) => `/** @jsx Devvit.createElement */
/** @jsxFrag Devvit.Fragment */

import { Devvit, useState, useChannel, useAsync } from '@devvit/public-api';

// Configuration
Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

// Custom Post Type with WebView
Devvit.addCustomPostType({
  name: '${title.replace(/'/g, "\\'")}',
  height: 'tall',
  render: (context) => {
    const [key, setKey] = useState(0);
    
    // Realtime Channel for multiplayer sync
    const channelName = \`game_\${context.postId || 'global'}\`;
    
    const channel = useChannel({
      name: channelName,
      onMessage: (msg) => {
        // Forward realtime messages to WebView
        context.ui.webView.postMessage('gameview', {
          type: 'REALTIME_EVENT',
          payload: msg
        });
      },
    });
    
    channel.subscribe();

    // Get current user for display
    const { data: currentUser, loading: userLoading } = useAsync(async () => {
      try {
        const user = await context.reddit.getCurrentUser();
        return user?.username || 'Anonymous';
      } catch (e) {
        console.error('Failed to get user:', e);
        return 'Anonymous';
      }
    });

    // Handle messages FROM WebView
    const handleWebViewMessage = async (msg) => {
      try {
        // 1. Console Logging
        if (msg.type === 'console') {
          const prefix = '[WebView]';
          const args = [prefix, ...(msg.args || [])];
          if (msg.level === 'error') console.error(...args);
          else if (msg.level === 'warn') console.warn(...args);
          else console.log(...args);
          return;
        }

        // 2. Database Operations (Redis)
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
          const parsed = {};
          
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

        // 3. Realtime Messaging
        if (msg.type === 'REALTIME_SEND') {
          const { event } = msg;
          await context.realtime.send(channelName, event);
          // Echo back to sender so they know it was sent (optional, but good for local updates)
          context.ui.webView.postMessage('gameview', {
            type: 'REALTIME_EVENT',
            payload: event
          });
          return;
        }

      } catch (error) {
        console.error('[Devvit Server Error]', error);
        // Try to report error back to webview if it was a request
        if (msg.reqId) {
             context.ui.webView.postMessage('gameview', {
                type: \`\${msg.type}_RESPONSE\`,
                reqId: msg.reqId,
                error: error instanceof Error ? error.message : 'Unknown Server Error'
             });
        }
      }
    };

    // Build WebView URL with username
    // We append the username to the query parameters so the client can read it
    const webviewUrl = \`${webviewPath}?username=\${encodeURIComponent(currentUser || 'Anonymous')}\`;

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="gameview"
          url={webviewUrl}
          width="100%"
          height="100%"
          key={key.toString()}
          onMessage={handleWebViewMessage}
        />
        <vstack padding="medium" gap="medium">
          <button icon="refresh" onPress={() => setKey(k => k + 1)}>
            Reload Game
          </button>
          <text size="small" color="neutral-content-weak">
            Playing as {currentUser || 'Anonymous'}
          </text>
        </vstack>
      </vstack>
    );
  },
});

// Creation Menu Item
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
      
      ui.showToast('Game post created!');
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast('Failed to create game post');
    }
  },
});

export default Devvit;
`;

