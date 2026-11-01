export const READ_TOOLS = [
  {
    name: 'knowledge_search',
    description:
      'Search the project knowledge base by short keywords (2–6 terms; prefer Russian synonyms used in articles). Empty query returns recently updated articles. Optional category_id limits results; call knowledge_list_categories for ids.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Short keyword query. Empty returns recent articles. Do not paste full sentences.',
        },
        limit: { type: 'integer', description: 'Max results (1–200, default 100).' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description:
            'Optional category id. Omit to search all articles. Pass null for uncategorized articles. Use knowledge_list_categories to get ids.',
        },
      },
    },
  },
  {
    name: 'knowledge_get',
    description:
      'Load a full knowledge-base article by id. Body is Markdown; screenshots are listed in images and as ![alt](url) in the body.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_list_categories',
    description: 'List knowledge-base categories (id, name, tags). Call this before assigning category_id.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

export const WRITE_TOOLS = [
  {
    name: 'knowledge_create',
    description:
      'Create a new knowledge-base article. Body is Markdown; image links (![alt](url) or [label](https://…png)) render as images. Use knowledge_add_screenshot after create to store screenshots. New articles stay unconfirmed until an admin confirms them.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title (required, max 200).' },
        body: { type: 'string', description: 'Markdown article body (required, max 20000).' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description: 'Optional category id. Omit or null for no category.',
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'knowledge_update',
    description:
      'Update an existing knowledge-base article. Body is Markdown; image links render as images. Use knowledge_add_screenshot to store screenshots. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown article body (max 20000).' },
        tags: { type: 'string' },
        category_id: {
          type: ['integer', 'number', 'null'],
          description: 'Optional category id. Pass null to clear the category.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_delete',
    description: 'Delete a knowledge-base article by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Article id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_add_screenshot',
    description:
      'Store a screenshot on an article and append Markdown ![alt](url) to the body. Prefer url (http/https image). data_base64 is for small images only. Fails if the article is locked.',
    inputSchema: {
      type: 'object',
      properties: {
        article_id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        url: { type: 'string', description: 'Public http(s) image URL to download and store. Preferred.' },
        data_base64: { type: 'string', description: 'Raw or data-URL base64 image (JPEG, PNG, WebP, GIF).' },
        filename: { type: 'string', description: 'Original file name (optional).' },
        alt: { type: 'string', description: 'Alt text for the Markdown image (optional).' },
      },
      required: ['article_id'],
    },
  },
  {
    name: 'knowledge_delete_screenshot',
    description: 'Delete a stored screenshot from an article and remove its Markdown image from the body.',
    inputSchema: {
      type: 'object',
      properties: {
        article_id: { type: ['integer', 'number', 'string'], description: 'Article id' },
        image_id: { type: ['integer', 'number', 'string'], description: 'Screenshot id from knowledge_get images.' },
      },
      required: ['article_id', 'image_id'],
    },
  },
  {
    name: 'knowledge_create_category',
    description: 'Create a knowledge-base category.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Category name (required, max 100).' },
        tags: { type: 'string', description: 'Comma-separated tags.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'knowledge_update_category',
    description: 'Update a knowledge-base category. Omit fields you do not want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Category id' },
        name: { type: 'string' },
        tags: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'knowledge_delete_category',
    description: 'Delete a knowledge-base category. Articles in it become uncategorized.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'number', 'string'], description: 'Category id' },
      },
      required: ['id'],
    },
  },
];
