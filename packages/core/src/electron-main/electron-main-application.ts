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

import * as electron from 'electron';
import nativeKeymap = require('native-keymap');
import ElectronStorage = require('electron-store');
import { injectable, inject, named } from 'inversify';
import { ContributionProvider, MaybePromise } from '../common';
import { Deferred } from '../common/promise-util';

export const ElectronMainApplicationContribution = Symbol('ElectronMainApplicationContribution');
export interface ElectronMainApplicationContribution {

    onStart?(app: Electron.App): MaybePromise<void>;

    /**
     * Will wait for both the electron `ready` event, and all contributions to
     * finish executing `onStart`.
     *
     * @param infos Data passed by electron to the `on('ready', ...)` listener.
     */
    // tslint:disable-next-line:no-any
    onReady?(infos: any): MaybePromise<void>;

    onQuit?(): MaybePromise<void>;
}

export interface ElectronBrowserWindowOptions extends electron.BrowserWindowConstructorOptions {
    isMaximized?: boolean,
}

const WindowState = 'windowstate';
interface WindowState {
    isMaximized?: boolean
    height: number
    width: number
    x: number
    y: number
}
export interface ElectronMainApplicationStorage {
    [WindowState]: WindowState;
}

@injectable()
export class ElectronMainApplication {

    @inject('theia-application-name')
    protected readonly applicationName: string;

    @inject('theia-backend-main-path')
    protected readonly mainPath: string;

    @inject('theia-index-html-path')
    protected readonly indexHtml: string;

    @inject(ContributionProvider) @named(ElectronMainApplicationContribution)
    protected readonly contributions: ContributionProvider<ElectronMainApplicationContribution>;

    // tslint:disable-next-line:no-any
    protected readonly storage = new ElectronStorage<ElectronMainApplicationStorage>();

    protected readonly startDeferred = new Deferred<void>();
    protected readonly whenStarted = this.startDeferred.promise;

    async start(app: electron.App): Promise<void> {
        // tslint:disable-next-line:no-any
        app.on('ready', (infos: any) => this.ready(infos));
        try {
            await Promise.all(this.contributions.getContributions()
                .map(contribution => contribution.onStart && contribution.onStart(app)));
            this.startDeferred.resolve();
        } catch (error) {
            this.startDeferred.reject(error);
        }
    }

    // tslint:disable-next-line:no-any
    protected async ready(infos: any): Promise<void> {
        await this.whenStarted;
        this.bindIpcEvents();
        await this.setTempMenu();
        await Promise.all(this.contributions.getContributions()
            .map(contribution => contribution.onReady && contribution.onReady(infos)));
    }

    protected async quit(): Promise<void> {

    }

    protected bindIpcEvents(): void {
        electron.ipcMain.on('create-new-window',
            (event: electron.IpcMessageEvent, url?: string) => this.createNewWindow(url));
        electron.ipcMain.on('open-external',
            (event: electron.IpcMessageEvent, url?: string) => url && this.openExternally(url));
    }

    protected async createNewWindow(url?: string): Promise<electron.BrowserWindow> {
        const windowOptions: ElectronBrowserWindowOptions = {
            show: false,
            ...await this.getWindowOptions(url),
        }

        // Always hide the window, we will show the window when it is ready to be shown in any case.
        const newWindow = new electron.BrowserWindow(windowOptions);
        if (windowOptions.isMaximized) {
            newWindow.maximize();
        }
        newWindow.on('ready-to-show', () => newWindow.show());

        // Prevent calls to "window.open" from opening an ElectronBrowser window,
        // and rather open in the OS default web browser.
        // tslint:disable-next-line:no-shadowed-variable
        newWindow.webContents.on('new-window', (event, url) => {
            event.preventDefault();
            electron.shell.openExternal(url);
        });

        // Notify the renderer process on keyboard layout change
        nativeKeymap.onDidChangeKeyboardLayout(() => {
            if (!newWindow.isDestroyed()) {
                const newLayout = {
                    info: nativeKeymap.getCurrentKeyboardLayout(),
                    mapping: nativeKeymap.getKeyMap()
                };
                newWindow.webContents.send('keyboardLayoutChanged', newLayout);
            }
        });

        if (url) {
            newWindow.loadURL(url);
        }
        return newWindow;
    }

    protected getWindowOptions(url?: string): MaybePromise<ElectronBrowserWindowOptions> {
        // We must center by hand because \`browserWindow.center()\` fails on multi-screen setups
        // See: https://github.com/electron/electron/issues/3490
        const { bounds } = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
        const height = Math.floor(bounds.height * (2 / 3));
        const width = Math.floor(bounds.width * (2 / 3));

        const y = Math.floor(bounds.y + (bounds.height - height) / 2);
        const x = Math.floor(bounds.x + (bounds.width - width) / 2);

        const windowState = this.storage.get(WindowState, {
            width, height, x, y,
        });

        return {
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
    }

    protected async bindWindowEvents(window: electron.BrowserWindow): Promise<void> {
        await this.bindSaveWindowState(window);
    }

    protected bindSaveWindowState(window: electron.BrowserWindow): MaybePromise<void> {
        const saveWindowState = () => {
            try {
                // tslint:disable-next-line:no-shadowed-variable
                let bounds: electron.Rectangle;
                if (window.isMaximized()) {
                    // tslint:disable-next-line:no-any
                    bounds = this.storage.get(WindowState, {} as WindowState);
                } else {
                    bounds = window.getBounds();
                }
                this.storage.set(WindowState, {
                    isMaximized: window.isMaximized(),
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
        window.on('close', saveWindowState);
        window.on('resize', saveWindowStateDelayed);
        window.on('move', saveWindowStateDelayed);
    }

    protected openExternally(url: string): MaybePromise<void> {
        electron.shell.openExternal(url);
    }

    /**
     * Remove the default electron menus, waiting for the application to set its own.
     */
    protected setTempMenu(): MaybePromise<void> {
        electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate([{
            role: 'help', submenu: [{ role: 'toggledevtools' }]
        }]));
    }

}
