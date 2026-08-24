# 🚛 Sistema de Gestão de Frota

Sistema web para gerenciamento e acompanhamento de frotas de veículos, desenvolvido para facilitar o controle de viagens, motoristas, veículos, abastecimentos, paradas, quilometragem, manutenção e localização.

O sistema possui diferentes níveis de acesso para administradores e motoristas, permitindo acompanhar as operações da frota e gerar alertas para situações que exigem atenção.

## 📋 Sobre o projeto

O Sistema de Gestão de Frota foi desenvolvido com o objetivo de centralizar o controle das operações de veículos e motoristas.

O motorista pode iniciar e finalizar viagens, registrar paradas, abastecimentos e informações relacionadas à viagem. O sistema também utiliza a localização do dispositivo para registrar a posição inicial e acompanhar as informações relacionadas à rota.

Para os administradores, o sistema disponibiliza recursos para gerenciamento dos veículos, motoristas, viagens, manutenções e alertas.

Um dos principais mecanismos de segurança é a validação da quilometragem informada pelo motorista. Caso seja identificado um salto de quilometragem sem registro anterior, o sistema pode bloquear o veículo e gerar um alerta para o administrador.

## ✨ Funcionalidades

### 🚛 Gestão de veículos

- Cadastro e gerenciamento de veículos
- Controle de placa e modelo
- Controle da quilometragem atual
- Ativação e bloqueio de veículos
- Associação de veículos aos motoristas
- Controle de veículos autorizados para cada motorista

### 👨‍✈️ Gestão de motoristas

- Cadastro de motoristas
- Autenticação de usuários
- Controle de acesso por perfil
- Perfil de administrador
- Perfil de motorista
- Controle de autorização de motoristas para veículos

### 🛣️ Gestão de viagens

- Início de viagem
- Finalização de viagem
- Registro da obra/serviço relacionado à viagem
- Registro da quilometragem inicial e final
- Registro da localização inicial
- Controle de viagens em andamento
- Associação entre motorista, veículo e viagem

### 📍 GPS e localização

- Utilização da localização do dispositivo
- Registro da posição inicial da viagem
- Registro de localização das paradas
- Visualização da rota e das paradas no mapa
- Integração com mapas através do Leaflet

### ⛽ Paradas e abastecimentos

O motorista pode registrar diferentes tipos de parada, incluindo:

- Abastecimento
- Refeição
- Outras paradas
- Quantidade de combustível abastecida
- Data e hora da parada
- Localização da parada

### 🔧 Manutenção

- Cadastro de manutenções
- Controle da quilometragem da manutenção
- Definição da próxima manutenção
- Alertas de manutenção próxima
- Identificação de manutenções vencidas
- Histórico de manutenções realizadas
- Registro de valor gasto
- Registro da quilometragem na realização da manutenção

> ⚠️ O módulo de manutenção ainda está em desenvolvimento e algumas funcionalidades podem sofrer alterações.

### ⚠️ Sistema de alertas

O sistema possui mecanismos para identificar situações que podem indicar problemas na operação da frota.

Entre elas:

- Tentativa de utilização de veículo por motorista não autorizado
- Salto de quilometragem sem registro
- Veículo bloqueado por inconsistência de quilometragem
- Manutenções vencidas
- Manutenções próximas
- Alertas com diferentes níveis de severidade

## 🔐 Segurança

O sistema possui autenticação e controle de acesso baseado no perfil do usuário.

As senhas são armazenadas utilizando hash com `bcryptjs` e as sessões são controladas por tokens.

Existem rotas específicas para administradores e motoristas, impedindo que um usuário acesse operações que não pertencem ao seu perfil.

Além disso, o projeto possui análise automática de código utilizando GitHub CodeQL.

## 🛠️ Tecnologias utilizadas

### Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- React Router
- React Leaflet
- Leaflet
- Recharts
- Chart.js
- Lucide React
- Motion

### Backend

- Node.js
- Express
- TypeScript
- SQLite
- Better SQLite3
- bcryptjs

### Segurança e desenvolvimento

- GitHub Actions
- GitHub CodeQL
- TypeScript

## 📦 Pré-requisitos

Antes de executar o projeto, certifique-se de possuir:

- Node.js
- npm

## 🚀 Instalação

Clone o repositório:

```bash
git clone https://github.com/caioFeltrin/Sistema-de-Frota.git
