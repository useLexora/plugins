export async function documentAction(surface, row, action) {
  await row.getByRole('button', { name: '更多操作', exact: true }).click()
  await surface.getByRole('menuitem', { name: action, exact: true }).click()
}

export async function editorAction(surface, action) {
  if (action === '导出') action = '保存副本…'
  await surface.getByRole('button', { name: '文件菜单', exact: true }).click()
  await surface.getByRole('menuitem', { name: action, exact: true }).click()
}
