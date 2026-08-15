ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js ./
COPY bin ./bin

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
