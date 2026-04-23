/**
 * NEFイベントデータ管理 - Google Apps Script
 * 共有ドライブの全ファイルを取得→ツリー構築→Driveに保存
 *
 * 使い方:
 * 1. rebuildCache() を手動実行して初回キャッシュ構築
 * 2. setupTrigger() を手動実行して1時間ごとの自動更新を設定
 * 3. ウェブアプリとしてデプロイ
 */

var ROOT_FOLDER_ID = '0ALcmhlztoeztUk9PVA';
var CACHE_FILE_NAME = '_nef_cache.json';

// --- Web App エンドポイント（JSONP対応） ---
function doGet(e) {
  var callback = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : null;

  var json = loadCache();
  if (!json) {
    try {
      var tree = fetchAndBuildTree();
      json = JSON.stringify(tree);
      saveCache(json);
    } catch (err) {
      json = JSON.stringify({ error: err.message });
    }
  }

  if (callback) {
    // JSONP: callbackで包んで返す
    var output = ContentService.createTextOutput(callback + '(' + json + ')');
    output.setMimeType(ContentService.MimeType.JAVASCRIPT);
    return output;
  } else {
    var output = ContentService.createTextOutput(json);
    output.setMimeType(ContentService.MimeType.JSON);
    return output;
  }
}

// --- キャッシュ構築 ---
function rebuildCache() {
  var tree = fetchAndBuildTree();
  var json = JSON.stringify(tree);
  saveCache(json);
  Logger.log('キャッシュ更新完了: ' + json.length + ' bytes');
}

// --- 1時間ごとの自動更新トリガー ---
function setupTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'rebuildCache') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('rebuildCache')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('トリガー設定完了');
}

// --- フラット取得 → ツリー構築 ---
function fetchAndBuildTree() {
  var flatList = fetchAllFiles();
  Logger.log('フラット取得完了: ' + flatList.length + ' 件。ツリー構築開始...');
  var tree = buildTreeFromFlat(flatList, ROOT_FOLDER_ID);
  Logger.log('ツリー構築完了');
  return tree;
}

// --- フラットリストからツリーを構築 ---
function buildTreeFromFlat(flatList, rootId) {
  // フォルダのマップを作成
  var folderMap = {};
  var i, item;

  for (i = 0; i < flatList.length; i++) {
    item = flatList[i];
    if (item.type === 'folder') {
      folderMap[item.id] = {
        id: item.id,
        title: item.title,
        type: 'folder',
        mimeType: item.mimeType,
        viewUrl: item.viewUrl,
        children: []
      };
    }
  }

  // ルート直下の要素を格納する配列
  var roots = [];

  // 全アイテムを親に紐付け
  for (i = 0; i < flatList.length; i++) {
    item = flatList[i];
    var parentId = item.parentId;
    var node;

    if (item.type === 'folder') {
      node = folderMap[item.id];
    } else {
      node = {
        id: item.id,
        title: item.title,
        type: 'file',
        mimeType: item.mimeType,
        viewUrl: item.viewUrl
      };
    }

    if (parentId === rootId || !parentId) {
      roots.push(node);
    } else if (folderMap[parentId]) {
      folderMap[parentId].children.push(node);
    } else {
      // 親が見つからない場合はルートに
      roots.push(node);
    }
  }

  // 再帰的にソート（フォルダ優先・名前順）
  sortNodes(roots);
  return roots;
}

function sortNodes(nodes) {
  nodes.sort(function(a, b) {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.title.localeCompare(b.title, 'ja');
  });
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].children) sortNodes(nodes[i].children);
  }
}

// --- 共有ドライブの全ファイルをフラットリストで取得 ---
function fetchAllFiles() {
  var allItems = [];
  var pageToken = null;
  var retryCount = 0;
  var maxRetries = 3;

  do {
    try {
      var params = {
        corpora: 'drive',
        driveId: ROOT_FOLDER_ID,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 460,
        fields: 'nextPageToken,files(id,name,mimeType,parents,webViewLink)',
        q: 'trashed = false'
      };
      if (pageToken) params.pageToken = pageToken;

      var res = Drive.Files.list(params);
      var files = res.files || [];

      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        var parentId = null;
        if (file.parents && file.parents.length > 0) {
          parentId = file.parents[0];
        }

        allItems.push({
          id: file.id,
          title: file.name,
          type: file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
          mimeType: file.mimeType,
          parentId: parentId,
          viewUrl: file.webViewLink
        });
      }

      pageToken = res.nextPageToken;
      retryCount = 0;
      Logger.log('取得中: ' + allItems.length + ' 件');
      Utilities.sleep(200);
    } catch (e) {
      retryCount++;
      Logger.log('エラー (リトライ ' + retryCount + '/' + maxRetries + '): ' + e.message);
      if (retryCount >= maxRetries) {
        Logger.log('最大リトライ到達、取得済み ' + allItems.length + ' 件で保存');
        break;
      }
      Utilities.sleep(3000);
    }
  } while (pageToken);

  Logger.log('取得完了: ' + allItems.length + ' 件');
  return allItems;
}

// --- Google DriveにJSONファイルとして保存 ---
function saveCache(json) {
  var files = DriveApp.getFilesByName(CACHE_FILE_NAME);
  if (files.hasNext()) {
    var file = files.next();
    file.setContent(json);
    Logger.log('キャッシュファイル更新: ' + file.getId());
  } else {
    var file = DriveApp.createFile(CACHE_FILE_NAME, json, 'application/json');
    Logger.log('キャッシュファイル作成: ' + file.getId());
  }
}

// --- Google DriveからJSONファイル読み込み ---
function loadCache() {
  var files = DriveApp.getFilesByName(CACHE_FILE_NAME);
  if (files.hasNext()) {
    return files.next().getBlob().getDataAsString();
  }
  return null;
}
