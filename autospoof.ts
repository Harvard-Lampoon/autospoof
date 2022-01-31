#!/usr/bin/env ts-node-transpile-only
import {
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync
} from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import * as YAML from "yaml";
import {
    request,
    GaxiosResponse
} from "gaxios";
import {
    google,
    drive_v3,
    docs_v1
} from "googleapis";
import {
    OAuth2Client
} from "google-auth-library";
import {
    registerPrompt,
    prompt
} from "inquirer";
declare module "inquirer-order-list";
import OrderList from "inquirer-order-list";

registerPrompt("order-list", OrderList);

const FOLDER_REGEXP = new RegExp("https://drive.google.com/drive/folders/(.*)");

const SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly"
];

interface Page {
    url: string;
    remove?: string[];
    script?: string;
}

interface Article {
    title: string;
    subtitle?: string;
    image?: string;
}

interface FullArticle extends Article {
    body: string;
}

interface Configuration {
    frontpage: Page & {
        articles: Record<string, Article | null>;
    };
    article: Page & FullArticle;
    default: string;
}

interface SavedCredentials {
    installed: {
        client_secret: string;
        client_id: string;
        redirect_uris: string[];
    };
}

if (process.argv.length !== (2 + 4)) {
    console.error(`Usage: ${process.argv.join(" ")} <siteconfig.yaml> <client_secret.json> <docs> <output>

Arguments:
    siteconfig.yaml: Configuration to spoof a particular media outlet. See the README.org file for documentation.
    client_secret.json: OAuth client secret downloaded from Google Clould Console.
    docs: Google Drive folder ID with parody articles.
    output: Directory in which to store static parody site.`);
    process.exit(1);
}

const unwrap = <T>(res: GaxiosResponse<T>): T => {
    if (res.status !== 200) {
        throw `Received status ${res.status} while trying to access ${res.request.responseURL}`;
    }
    return res.data;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const mkdir = (dir: string) => existsSync(dir) || mkdirSync(dir);

const safeName = (str: string): string => str.replace(/[^A-Z0-9]/, "-").toLowerCase();

const getPage = async (page: Page): Promise<cheerio.CheerioAPI> => {
    const $ = cheerio.load(unwrap(await request({
        url: page.url,
        responseType: "text"
    })));
    for (let remove of page.remove) {
        $(remove).remove();
    }
    page.script && $("body").append($("<script>${page.script}</script>"));
    return $;
};

const auth = async ({ installed: credentials }: SavedCredentials) => {
    const oAuth2Client: OAuth2Client = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, credentials.redirect_uris[0]);
    console.log(`Login to an account with access to the docs: ` + oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES
    }));
    const { code } = await prompt([{
        type: "password",
        message: "Enter the code from that page here: ",
        name: "code",
        mask: "*"
    }]);
    oAuth2Client.setCredentials((await oAuth2Client.getToken(code)).tokens);
    return oAuth2Client;
}

const spoof = async (config: Configuration, oAuth2Client: OAuth2Client, docsUrl: string, output: string) => {
    const drive = google.drive({
        version: "v3",
        auth: oAuth2Client
    });
    const docs = google.docs({
        version: "v1",
        auth: oAuth2Client
    });
    const folder = FOLDER_REGEXP.exec(docsUrl)?.[1];
    if (!folder) {
        throw docsUrl + " is not a valid Google Drive folder URL";
    }
    const articles: FullArticle[] = [];
    mkdir(output)
    mkdir(path.join(output, "articles"));
    mkdir(path.join(output, "images"));
    for (let { id, name } of unwrap(await drive.files.list({
        pageSize: 1000,
        q: `'${folder}' in parents and mimeType = 'application/vnd.google-apps.document'`,
        fields: "files(id, name)"
    })).files) {
        console.log(`Processing "${name}"...`);
        const document = unwrap(await docs.documents.get({
            documentId: id
        }));
        let body = "";
        for (let { paragraph } of document.body.content) {
            if (!paragraph?.elements) {
                continue;
            }
            for (let { textRun } of paragraph?.elements) {
                const text = textRun?.content;
                if (!text || text.trim().toUpperCase() == name) {
                    continue;
                }
                body += text;
            }
        }
        let image = undefined;
        const imageRes = await request<any>({
            url: Object.values(document.inlineObjects ?? {})[0]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri ||
                Object.values(document.positionedObjects ?? {})[0]?.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri,
            responseType: "arraybuffer"
        });
        if (imageRes.status === 200) {
            image = path.join(output, "images", safeName(name) + "." + imageRes.headers["Content-Type"].substring("image/".length));
            writeFileSync(image, imageRes.data);
        } else {
            console.error(`Received status ${imageRes.status} while trying to access image`);
        }
        articles.push({
            title: name,
            subtitle: body.split("\n")[0],
            body: body.trim(),
            image
        });
        await sleep(1000);
    }
    articles.sort((a: FullArticle, b: FullArticle): number => {
        if (a.hasOwnProperty("image") === b.hasOwnProperty("image")) {
            return 0;
        } else if (b.image) {
            return 1;
        } else {
            return -1;
        }
    });
    console.log(await prompt([{
        type: "order-list",
        message: "Order parody articles by priority, most important first: ",
        name: "priority",
        choices: articles.map((article: FullArticle) => ({
            name: article.title,
            value: article
        }))
    }]));
    return;
    const article = await getPage(config.article);
    // writeFileSync(path.join(output, "articles", safeName), article.html());
    const frontpage = await getPage(config.frontpage);
};
if (require.main === module) {
    auth(JSON.parse(readFileSync(process.argv[3], "utf8")) as SavedCredentials)
        .then(oAuth2Client => spoof(YAML.parse(readFileSync(process.argv[2], "utf8")) as Configuration, oAuth2Client, process.argv[4], process.argv[5]))
        .catch(error => console.error(error));
}
