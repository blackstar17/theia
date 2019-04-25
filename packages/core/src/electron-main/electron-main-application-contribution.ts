/********************************************************************************
 * Copyright (C) 2019 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import electron = require('electron');
import { fork } from 'child_process';
import { inject, injectable } from 'inversify';
import { ElectronStorageService } from './electron-storage-service';
import { ElectronMainApplicationContribution } from './electron-main-application';
import { ElectronNativeKeymapService } from './electron-native-keymap-service';

const WindowState = 'windowstate';
interface WindowState {
    isMaximized?: boolean
    height: number
    width: number
    x: number
    y: number
}

@injectable()
export class DefaultElectronMainApplicationContribution implements ElectronMainApplicationContribution {

    @inject(ElectronStorageService)
    protected readonly electronStorageService: ElectronStorageService;

    @inject(ElectronNativeKeymapService)
    protected readonly nativeKeymapService: ElectronNativeKeymapService;

    @inject('theia-application-name')
    protected readonly applicationName: string;

    @inject('theia-backend-main-path')
    protected readonly mainPath: string;

    @inject('theia-index-html-path')
    protected readonly indexHtml: string;

    onStart(app: electron.App) {
        app.on('ready', () => this.ready(app));
    }

    protected ready(app: electron.App) {
        const { shell, Menu, ipcMain } = electron;

        // Remove the default electron menus, waiting for the application to set its own.
        Menu.setApplicationMenu(Menu.buildFromTemplate([{
            role: 'help', submenu: [{ role: 'toggledevtools' }]
        }]));

        app.on('window-all-closed', () => {
            app.quit();
        });
        // tslint:disable-next-line:no-any
        ipcMain.on('create-new-window', (event: any, url: string) => {
            this.createNewWindow(url);
        });
        // tslint:disable-next-line:no-any
        ipcMain.on('open-external', (event: any, url: string) => {
            shell.openExternal(url);
        });

        // Check whether we are in bundled application or development mode.
        // @ts-ignore
        const devMode = process.defaultApp || /node_modules[\/]electron[\/]/.test(process.execPath);
        const mainWindow = this.createNewWindow();
        const loadMainWindow = (port: number) => {
            if (!mainWindow.isDestroyed()) {
                mainWindow.loadURL('file://' + this.indexHtml + '?port=' + port);
            }
        };

        // We need to distinguish between bundled application and development mode when starting the clusters.
        // See: https://github.com/electron/electron/issues/6337#issuecomment-230183287
        if (devMode) {
            // tslint:disable-next-line:no-any
            require(this.mainPath).then((address: any) => {
                loadMainWindow(address.port);
            }).catch((error: Error) => {
                console.error(error);
                app.exit(1);
            });
        } else {
            const cp = fork(this.mainPath, [], { env: { ...process.env } });
            // tslint:disable-next-line:no-any
            cp.on('message', (message: any) => {
                loadMainWindow(message);
            });
            cp.on('error', (error: Error) => {
                console.error(error);
                app.exit(1);
            });
            app.on('quit', () => {
                // If we forked the process for the clusters, we need to manually terminate it.
                // See: https://github.com/theia-ide/theia/issues/835
                process.kill(cp.pid);
            });
        }
    }

    protected createNewWindow(theUrl?: string): electron.BrowserWindow {
        const { screen, shell, BrowserWindow } = electron;

        // We must center by hand because \`browserWindow.center()\` fails on multi-screen setups
        // See: https://github.com/electron/electron/issues/3490
        const { bounds } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const height = Math.floor(bounds.height * (2 / 3));
        const width = Math.floor(bounds.width * (2 / 3));

        const y = Math.floor(bounds.y + (bounds.height - height) / 2);
        const x = Math.floor(bounds.x + (bounds.width - width) / 2);

        const windowState = this.electronStorageService.get<WindowState>(WindowState, {
            width, height, x, y,
        });

        const windowOptions: electron.BrowserWindowConstructorOptions & {
            isMaximized?: boolean,
        } = {
            show: false,
            title: this.applicationName,
            width: windowState.width,
            height: windowState.height,
            minWidth: 200,
            minHeight: 120,
            x: windowState.x,
            y: windowState.y,
            isMaximized: windowState.isMaximized
        };

        // Always hide the window, we will show the window when it is ready to be shown in any case.
        const newWindow = new BrowserWindow(windowOptions);
        if (windowOptions.isMaximized) {
            newWindow.maximize();
        }
        newWindow.on('ready-to-show', () => newWindow.show());

        // Prevent calls to "window.open" from opening an ElectronBrowser window,
        // and rather open in the OS default web browser.
        newWindow.webContents.on('new-window', (event, url) => {
            event.preventDefault();
            shell.openExternal(url);
        });

        // Save the window geometry state on every change
        const saveWindowState = () => {
            try {
                // tslint:disable-next-line:no-shadowed-variable
                let bounds: electron.Rectangle;
                if (newWindow.isMaximized()) {
                    // tslint:disable-next-line:no-any
                    bounds = this.electronStorageService.get<WindowState>(WindowState, {} as WindowState);
                } else {
                    bounds = newWindow.getBounds();
                }
                this.electronStorageService.set<WindowState>(WindowState, {
                    isMaximized: newWindow.isMaximized(),
                    width: bounds.width,
                    height: bounds.height,
                    x: bounds.x,
                    y: bounds.y
                });
            } catch (e) {
                console.error('Error while saving window state.', e);
            }
        };
        // tslint:disable-next-line:no-any
        let delayedSaveTimeout: any;
        const saveWindowStateDelayed = () => {
            if (delayedSaveTimeout) {
                clearTimeout(delayedSaveTimeout);
            }
            delayedSaveTimeout = setTimeout(saveWindowState, 1000);
        };
        newWindow.on('close', saveWindowState);
        newWindow.on('resize', saveWindowStateDelayed);
        newWindow.on('move', saveWindowStateDelayed);

        // Notify the renderer process on keyboard layout change
        this.nativeKeymapService.onDidChangeKeyboardLayout(() => {
            if (!newWindow.isDestroyed()) {
                const newLayout = {
                    info: this.nativeKeymapService.getCurrentKeyboardLayout(),
                    mapping: this.nativeKeymapService.getKeyMap()
                };
                newWindow.webContents.send('keyboardLayoutChanged', newLayout);
            }
        });

        if (!!theUrl) {
            newWindow.loadURL(theUrl);
        }
        return newWindow;
    }

}
