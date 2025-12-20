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

    // Handle messages FROM WebView
    // Get current user
    const [currentUser] = useAsync(async () => {
      try {
        const user = await context.reddit.getCurrentUser();
        return user?.username || 'Anonymous';
      } catch (e) {
        console.error('Failed to get user:', e);
        return 'Anonymous';
      }
    }, {});
    
    // Queue for Redis operations (workaround for ServerCallRequired)
    const [redisQueue, setRedisQueue] = useState([]);
    
    // Process Redis queue using useAsync
    useAsync(async () => {
      if (redisQueue.length === 0) return;
      
      const operation = redisQueue[0];
      
      try {
        if (operation.type === 'DB_SET') {
          const { collection, id, data, reqId } = operation;
          await context.redis.hSet(\`websim:col:\${collection}\`, { 
            [id]: JSON.stringify(data) 
          });
          
          context.ui.webView.postMessage('gameview', {
            type: 'DB_SET_RESPONSE',
            reqId,
            success: true,
            id
          });
        } else if (operation.type === 'DB_GET') {
          const { collection, reqId } = operation;
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
        } else if (operation.type === 'DB_DELETE') {
          const { collection, id, reqId } = operation;
          await context.redis.hDel(\`websim:col:\${collection}\`, [id]);
          
          context.ui.webView.postMessage('gameview', {
            type: 'DB_DELETE_RESPONSE',
            reqId,
            success: true
          });
        }
      } catch (error) {
        console.error('[Redis Operation Error]', error);
        if (operation.reqId) {
          context.ui.webView.postMessage('gameview', {
            type: \`\${operation.type}_RESPONSE\`,
            reqId: operation.reqId,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }
      }
      
      // Remove processed operation
      setRedisQueue(queue => queue.slice(1));
    }, {
      depends: [redisQueue]
    });

    const handleWebViewMessage = (msg) => {
      try {
        // Console logging
        if (msg.type === 'console') {
          const prefix = '[WebView]';
          const args = [prefix, ...(msg.args || [])];
          if (msg.level === 'error') console.error(...args);
          else if (msg.level === 'warn') console.warn(...args);
          else console.log(...args);
          return;
        }

        // Queue Redis operations
        if (msg.type === 'DB_SET' || msg.type === 'DB_GET' || msg.type === 'DB_DELETE') {
          setRedisQueue(queue => [...queue, msg]);
          return;
        }

        // Realtime can be called directly
        if (msg.type === 'REALTIME_SEND') {
          const { event } = msg;
          context.realtime.send(channelName, event);
          context.ui.webView.postMessage('gameview', {
            type: 'REALTIME_EVENT',
            payload: event
          });
          return;
        }

      } catch (error) {
        console.error('[Devvit Server Error]', error);
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

