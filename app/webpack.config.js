const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
module.exports = [
  // Main process
  {
    mode: 'production',
    entry: './src/main/main.ts',
    target: 'electron-main',
    module: {
      rules: [{
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }],
    },
    resolve: { extensions: ['.ts', '.js'] },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'main.js',
    },
    externals: {
      'sql.js': 'commonjs sql.js',
      '@anthropic-ai/sdk': 'commonjs @anthropic-ai/sdk',
      'openai': 'commonjs openai',
      'express': 'commonjs express',
      'cors': 'commonjs cors',
      'localtunnel': 'commonjs localtunnel',
    },
  },
  // Preload
  {
    mode: 'production',
    entry: './src/main/preload.ts',
    target: 'electron-preload',
    module: {
      rules: [{
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      }],
    },
    resolve: { extensions: ['.ts', '.js'] },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'preload.js',
    },
  },
  // Renderer process
  {
    mode: 'production',
    entry: './src/renderer/index.tsx',
    target: 'web',
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: { loader: 'ts-loader', options: { configFile: 'tsconfig.renderer.json' } },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'renderer.js',
      chunkFilename: '[name].chunk.js',
      publicPath: './',
    },
    optimization: {
      splitChunks: {
        chunks: 'async',
        minSize: 10000,
      },
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './src/renderer/index.html',
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: './src/renderer/manifest.json', to: 'manifest.json' },
          { from: './src/renderer/sw.js', to: 'sw.js' },
          { from: '../admin-dashboard/index.html', to: 'admin.html' },
        ],
      }),
    ],
  },
];
